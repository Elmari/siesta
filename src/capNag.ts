import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSession } from './browser.js';
import type { Config } from './config.js';
import { readLastStamp } from './lastStamp.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { capNagLogPath, capNagPidPath } from './paths.js';
import { readStatus } from './stamp.js';
import { MAX_WORK_MS, formatDuration, summarizeToday } from './workLog.js';

const WARN_15_MS = 15 * 60_000;
const WARN_5_MS = 5 * 60_000;
const POST_CAP_REPEAT_MS = 5 * 60_000;
const MIN_RECHECK_MS = 60_000;
const MAX_SLEEP_MS = 30 * 60_000;

export function readCapNagPid(): number | null {
  const p = capNagPidPath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

function writeCapNagPid(pid: number): void {
  const p = capNagPidPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(pid), 'utf8');
}

function clearCapNagPid(): void {
  const p = capNagPidPath();
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

export function stopCapNag(): { stopped: boolean; pid?: number } {
  const pid = readCapNagPid();
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* may have died between checks */
    }
    clearCapNagPid();
    return { stopped: true, pid };
  }
  if (pid) clearCapNagPid();
  return { stopped: false };
}

export function startCapNag(): { started: boolean; pid: number } {
  const existing = readCapNagPid();
  if (existing && isAlive(existing)) {
    log.debug(`siesta: cap-nag already running (pid ${existing})`);
    return { started: false, pid: existing };
  }
  if (existing) clearCapNagPid();

  mkdirSync(dirname(capNagLogPath()), { recursive: true });
  const out = openSync(capNagLogPath(), 'a');
  const err = openSync(capNagLogPath(), 'a');

  const entry = process.argv[1];
  const child = spawn(process.execPath, [entry, '__cap-nag-loop'], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, SIESTA_CAP_NAG_CHILD: '1' },
  });
  child.unref();
  writeCapNagPid(child.pid!);
  return { started: true, pid: child.pid! };
}

export async function runCapNagLoop(config: Config): Promise<void> {
  log.info(`siesta: cap-nag loop started (pid ${process.pid}); cap = ${formatDuration(MAX_WORK_MS)}`);

  let stopped = false;
  const cleanup = (signal?: string): void => {
    stopped = true;
    log.info(`siesta: cap-nag loop stopping${signal ? ` (${signal})` : ''}`);
    clearCapNagPid();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error(
      { err: err instanceof Error ? err.stack ?? err.message : String(err) },
      'siesta: cap-nag uncaughtException — staying alive',
    );
  });
  process.on('unhandledRejection', (reason) => {
    log.error(
      { reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) },
      'siesta: cap-nag unhandledRejection — staying alive',
    );
  });

  let warnedAt15 = false;
  let warnedAt5 = false;
  let warnedAtCap = false;

  const verifyAndNotify = async (title: string, body: string): Promise<boolean> => {
    const stillAnwesend = await checkServerAnwesend(config);
    if (stillAnwesend === false) {
      log.info('siesta: cap-nag verified abwesend on server — exiting');
      cleanup('flipped to abwesend (server)');
      return false;
    }
    // null = check failed; we still notify rather than swallow the warning.
    notify(title, body, config.nag.sound);
    return true;
  };

  while (!stopped) {
    const last = readLastStamp();
    if (!last || last.presence !== 'anwesend') {
      log.info('siesta: cap-nag detected user is no longer anwesend (local) — exiting');
      cleanup('flipped to abwesend');
      return;
    }

    const remaining = MAX_WORK_MS - summarizeToday().totalMs;

    if (remaining <= 0) {
      const ok = warnedAtCap
        ? await verifyAndNotify('siesta — über Cap', `${Math.floor(-remaining / 60_000)}min über 10h 15min. Bitte ausstempeln.`)
        : await verifyAndNotify('siesta — Tagescap erreicht', 'Du hast 10h 15min voll. Bitte ausstempeln.');
      if (!ok) return;
      warnedAtCap = true;
      await sleep(POST_CAP_REPEAT_MS);
      continue;
    }

    if (remaining <= WARN_5_MS && !warnedAt5) {
      const ok = await verifyAndNotify('siesta — gleich am Cap', `Noch ${Math.ceil(remaining / 60_000)}min bis 10h 15min.`);
      if (!ok) return;
      warnedAt5 = true;
      await sleep(boundedSleep(remaining));
      continue;
    }

    if (remaining <= WARN_15_MS && !warnedAt15) {
      const ok = await verifyAndNotify('siesta — bald am Cap', `Noch ${Math.ceil(remaining / 60_000)}min bis 10h 15min.`);
      if (!ok) return;
      warnedAt15 = true;
      await sleep(boundedSleep(remaining - WARN_5_MS));
      continue;
    }

    // Way before any threshold — sleep until the 15-min warn point, but cap the sleep so
    // a user clocking out via the intranet UI is detected within MAX_SLEEP_MS.
    const untilWarn15 = remaining - WARN_15_MS;
    await sleep(boundedSleep(untilWarn15));
  }
}

/**
 * Returns true if anwesend, false if abwesend, null on read failure.
 * Side effect: readStatus reconciles local state from the server.
 */
async function checkServerAnwesend(config: Config): Promise<boolean | null> {
  try {
    const session = await openSession(config, { headed: false });
    try {
      const s = await readStatus(session.page, config);
      await session.saveState();
      if (s === 'anwesend') return true;
      if (s === 'abwesend') return false;
      return null;
    } finally {
      await session.close();
    }
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, 'siesta: cap-nag server check failed');
    return null;
  }
}

function boundedSleep(ms: number): number {
  if (ms < MIN_RECHECK_MS) return MIN_RECHECK_MS;
  if (ms > MAX_SLEEP_MS) return MAX_SLEEP_MS;
  return ms;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
