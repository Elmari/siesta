import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { openSession } from './browser.js';
import { readStatus } from './stamp.js';
import { notify } from './notify.js';
import { nagLogPath, nagPidPath } from './paths.js';
import { log } from './log.js';

export function readNagPid(): number | null {
  const p = nagPidPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function writeNagPid(pid: number): void {
  const p = nagPidPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(pid), 'utf8');
}

function clearNagPid(): void {
  const p = nagPidPath();
  if (existsSync(p)) unlinkSync(p);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopNag(): { stopped: boolean; pid?: number } {
  const pid = readNagPid();
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* may have died between checks */
    }
    clearNagPid();
    return { stopped: true, pid };
  }
  if (pid) clearNagPid();
  return { stopped: false };
}

export function startNag(): { started: boolean; pid: number } {
  const existing = readNagPid();
  if (existing && isAlive(existing)) {
    log.debug(`siesta: nag already running (pid ${existing})`);
    return { started: false, pid: existing };
  }
  if (existing) clearNagPid();

  mkdirSync(dirname(nagLogPath()), { recursive: true });
  const out = openSync(nagLogPath(), 'a');
  const err = openSync(nagLogPath(), 'a');

  const entry = process.argv[1];
  const child = spawn(process.execPath, [entry, '__nag-loop'], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, SIESTA_NAG_CHILD: '1' },
  });
  child.unref();
  writeNagPid(child.pid!);
  return { started: true, pid: child.pid! };
}

export async function runNagLoop(config: Config): Promise<void> {
  if (!config.nag.enabled) {
    log.info('siesta: nag disabled in config — exiting child');
    return;
  }

  const startedAt = Date.now();
  const delayMs = config.nag.delay_minutes * 60_000;
  const intervalMs = config.nag.interval_minutes * 60_000;

  log.info(
    `siesta: nag loop started (pid ${process.pid}); first ping in ${config.nag.delay_minutes}m, then every ${config.nag.interval_minutes}m`,
  );

  let stopped = false;
  const cleanup = (signal?: string): void => {
    stopped = true;
    log.info(`siesta: nag loop stopping${signal ? ` (${signal})` : ''}`);
    clearNagPid();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  await sleep(delayMs);

  while (!stopped) {
    const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
    const status = await checkStatus(config).catch((e) => {
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'siesta: nag status check failed');
      return 'error' as const;
    });

    if (status === 'anwesend') {
      log.info('siesta: nag detected user is anwesend — exiting');
      notify('siesta', 'Du bist wieder eingestempelt — Mittag beendet 👍', config.nag.sound);
      cleanup('flipped to anwesend');
      return;
    }

    if (status === 'error') {
      notify(
        'siesta — Stempel-Check fehlgeschlagen',
        `Konnte den Status nicht lesen (${elapsedMin}m seit Pausenstart). Manuell prüfen?`,
        config.nag.sound,
      );
    } else {
      notify(
        'siesta — Mittagspause',
        `Du bist seit ${elapsedMin} Minuten ausgestempelt. \`moin\` nicht vergessen!`,
        config.nag.sound,
      );
    }

    await sleep(intervalMs);
  }
}

async function checkStatus(config: Config): Promise<'anwesend' | 'abwesend' | 'unknown'> {
  const session = await openSession(config, { headed: false });
  try {
    const s = await readStatus(session.page, config);
    await session.saveState();
    return s;
  } finally {
    await session.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
