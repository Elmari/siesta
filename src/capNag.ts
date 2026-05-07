import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.js';
import { readLastStamp } from './lastStamp.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { capNagLogPath, capNagPidPath } from './paths.js';
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

  let warnedAt15 = false;
  let warnedAt5 = false;
  let warnedAtCap = false;

  while (!stopped) {
    const last = readLastStamp();
    if (!last || last.presence !== 'anwesend') {
      log.info('siesta: cap-nag detected user is no longer anwesend — exiting');
      cleanup('flipped to abwesend');
      return;
    }

    const remaining = MAX_WORK_MS - summarizeToday().totalMs;

    if (remaining <= 0) {
      if (!warnedAtCap) {
        notify('siesta — Tagescap erreicht', 'Du hast 10h 15min voll. Bitte ausstempeln.', config.nag.sound);
        warnedAtCap = true;
      } else {
        const overMin = Math.floor(-remaining / 60_000);
        notify('siesta — über Cap', `${overMin}min über 10h 15min. Bitte ausstempeln.`, config.nag.sound);
      }
      await sleep(POST_CAP_REPEAT_MS);
      continue;
    }

    if (remaining <= WARN_5_MS && !warnedAt5) {
      notify('siesta — gleich am Cap', `Noch ${Math.ceil(remaining / 60_000)}min bis 10h 15min.`, config.nag.sound);
      warnedAt5 = true;
      await sleep(boundedSleep(remaining));
      continue;
    }

    if (remaining <= WARN_15_MS && !warnedAt15) {
      notify('siesta — bald am Cap', `Noch ${Math.ceil(remaining / 60_000)}min bis 10h 15min.`, config.nag.sound);
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
