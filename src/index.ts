#!/usr/bin/env node
import 'dotenv/config';
import { basename } from 'node:path';
import { Command } from 'commander';
import prompts from 'prompts';
import { loadConfig, writeSampleConfig } from './config.js';
import { deletePassword, getPassword, setPassword } from './credentials.js';
import { clearState, openSession } from './browser.js';
import { readStatus, stamp, type Presence, type StampResult } from './stamp.js';
import { readNagPid, runNagLoop, startNag, stopNag } from './nag.js';
import { clearLastStamp, readLastStamp, writeLastStamp } from './lastStamp.js';
import { appendStamp, clearStampLog, formatDuration, formatHm, summarizeToday } from './workLog.js';
import { log } from './log.js';

const MIN_ABSENCE_MS = 60_000;
const STAMP_HOUR_MIN = 6;
const STAMP_HOUR_MAX_EXCLUSIVE = 21;
const MAX_WORK_MS = (10 * 60 + 15) * 60_000;

const ALIAS_TO_TARGET: Record<string, Presence> = {
  moin: 'anwesend',
  ciao: 'abwesend',
  mahlzeit: 'abwesend',
};

async function main(): Promise<void> {
  const invokedAs = basename(process.argv[1] ?? '').replace(/\.[^.]+$/, '');

  // Detached child entry — kept hidden from user-facing CLI
  if (process.argv[2] === '__nag-loop' && process.env.SIESTA_NAG_CHILD === '1') {
    const { config } = loadConfig();
    await runNagLoop(config);
    return;
  }

  if (invokedAs in ALIAS_TO_TARGET) {
    await runStamp(ALIAS_TO_TARGET[invokedAs], parseStampOpts(process.argv.slice(2)), invokedAs);
    return;
  }

  const program = new Command();
  program.name('siesta').description('Stamp presence at intranet without the UI dance').version('0.1.0');

  program
    .command('in')
    .description('clock in (anwesend)')
    .option('--headed', 'show the browser window (debugging)')
    .option('--dry-run', 'go through login + selectors but skip the actual click')
    .action(async (opts) => runStamp('anwesend', opts, 'in'));

  program
    .command('out')
    .description('clock out (abwesend)')
    .option('--headed', 'show the browser window')
    .option('--dry-run', 'go through login + selectors but skip the actual click')
    .option('--nag', 'start lunch-nag loop after stamping out')
    .action(async (opts) => runStamp('abwesend', opts, opts.nag ? 'mahlzeit' : 'out'));

  program
    .command('status')
    .description('show current presence')
    .option('--headed', 'show the browser window')
    .action(async (opts) => runStatus(opts));

  program
    .command('login')
    .description('store / update your intranet password in the macOS Keychain')
    .action(async () => runLogin());

  program
    .command('logout')
    .description('remove the stored password and clear the browser session')
    .action(async () => runLogout());

  program
    .command('worked')
    .description('show how much you have worked today (offline — no browser roundtrip)')
    .action(() => runWorked());

  program
    .command('nag')
    .description('manually start (or stop) the lunch-nag loop')
    .option('--stop', 'stop a running nag loop')
    .option('--status', 'show whether a nag loop is currently running')
    .action((opts) => runNagCmd(opts));

  program
    .command('config')
    .description('config helpers')
    .command('init')
    .description('write a sample config file to ~/.config/siesta/config.yaml')
    .action(() => {
      try {
        const p = writeSampleConfig();
        console.log(`Wrote sample config to ${p}`);
        console.log('Edit it (set your username), then run `siesta login` to store your password.');
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(process.argv);
}

interface StampOpts {
  headed?: boolean;
  dryRun?: boolean;
}

function parseStampOpts(argv: string[]): StampOpts {
  return {
    headed: argv.includes('--headed'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function runStamp(target: Presence, opts: StampOpts, invokedAs: string): Promise<void> {
  if (!opts.dryRun) {
    const blocked = checkWriteAllowed(target);
    if (blocked) {
      console.log(blocked);
      return;
    }
  }

  const { config } = loadConfig();
  const session = await openSession(config, { headed: opts.headed });
  let result: StampResult;
  try {
    result = await stamp(session.page, config, target, { dryRun: opts.dryRun });
    await session.saveState();

    if (opts.dryRun) {
      if (!result.changed && result.before === target) {
        console.log(`[dry-run] Schon ${formatPresence(result.before)}. Es würde nichts geklickt.`);
      } else {
        console.log(`[dry-run] Würde stempeln: ${formatPresence(result.before)} → ${formatPresence(target)} (kein Klick gemacht)`);
      }
    } else if (!result.changed) {
      console.log(`Schon ${formatPresence(result.before)}. Nichts zu tun.`);
    } else {
      console.log(`${formatPresence(result.before)} → ${formatPresence(result.after)} ✓`);
      const settledTs = Date.now();
      const settled = result.after === 'unknown' ? target : result.after;
      writeLastStamp({ presence: settled, ts: settledTs });
      appendStamp(settled, settledTs);
      const summary = summarizeToday(settledTs);
      console.log(`  Heute gearbeitet: ${formatDuration(summary.totalMs)}`);
    }
  } finally {
    await session.close();
  }

  if (opts.dryRun) return;

  // Stamp-in always cancels any running nag.
  if (target === 'anwesend') {
    const stopped = stopNag();
    if (stopped.stopped) console.log('  (Nag-Loop gestoppt)');
  }

  // Auto-start nag after `mahlzeit` (and `siesta out --nag`).
  if (target === 'abwesend' && invokedAs === 'mahlzeit' && config.nag.enabled) {
    const { started, pid } = startNag();
    if (started) {
      console.log(
        `  (Nag-Loop läuft im Hintergrund, pid ${pid} — erste Erinnerung in ${config.nag.delay_minutes} min, danach alle ${config.nag.interval_minutes} min)`,
      );
    } else {
      console.log(`  (Nag-Loop lief schon, pid ${pid})`);
    }
  }
}

function checkWriteAllowed(target: Presence): string | null {
  const now = new Date();
  const h = now.getHours();
  if (h < STAMP_HOUR_MIN || h >= STAMP_HOUR_MAX_EXCLUSIVE) {
    return `⏰ Stempeln ist zwischen ${STAMP_HOUR_MAX_EXCLUSIVE}:00 und ${STAMP_HOUR_MIN}:00 gesperrt (aktuell ${pad2(h)}:${pad2(now.getMinutes())}).`;
  }

  if (target === 'anwesend') {
    const last = readLastStamp();
    if (last && last.presence === 'abwesend') {
      const elapsed = Date.now() - last.ts;
      if (elapsed < MIN_ABSENCE_MS) {
        const remaining = Math.ceil((MIN_ABSENCE_MS - elapsed) / 1000);
        return `⏳ Abwesenheit war erst vor ${Math.floor(elapsed / 1000)}s — Pausen müssen mindestens 1 Minute dauern. Warte noch ${remaining}s.`;
      }
    }

    const worked = summarizeToday().totalMs;
    if (worked >= MAX_WORK_MS) {
      return `🛑 Heute schon ${formatDuration(worked)} gearbeitet — Tageshöchstgrenze (10h 15min) erreicht. Kein erneutes Einstempeln möglich.`;
    }
  }

  return null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatPresence(p: Presence | 'unknown'): string {
  const useColor = process.stdout.isTTY;
  const wrap = (code: string, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  switch (p) {
    case 'anwesend':
      return wrap('32', `✅ anwesend`);
    case 'abwesend':
      return wrap('33', `🌙 abwesend`);
    default:
      return wrap('90', `❓ unknown`);
  }
}

function runWorked(): void {
  const summary = summarizeToday();
  if (summary.firstTs === null) {
    console.log('Heute noch nicht gestempelt.');
    return;
  }

  const total = formatDuration(summary.totalMs);
  const remaining = MAX_WORK_MS - summary.totalMs;
  const remainingStr = remaining > 0 ? formatDuration(remaining) : '0min';

  if (summary.openSinceTs !== null) {
    const since = formatHm(summary.openSinceTs);
    console.log(`✅ anwesend seit ${since}`);
    console.log(`Heute gearbeitet: ${total} (${summary.pairs > 0 ? `${summary.pairs} Pause${summary.pairs === 1 ? '' : 'n'} davor, ` : ''}noch ${remainingStr} bis 10h 15min)`);
  } else {
    const lastOut = summary.lastAbwesendTs !== null ? ` (zuletzt abgemeldet ${formatHm(summary.lastAbwesendTs)})` : '';
    console.log(`🌙 abwesend${lastOut}`);
    console.log(`Heute gearbeitet: ${total} (noch ${remainingStr} bis 10h 15min)`);
  }
}

async function runStatus(opts: { headed?: boolean }): Promise<void> {
  const { config } = loadConfig();
  const session = await openSession(config, { headed: opts.headed });
  try {
    const status = await readStatus(session.page, config);
    await session.saveState();
    console.log(formatPresence(status));
  } finally {
    await session.close();
  }
}

async function runLogin(): Promise<void> {
  const { config } = loadConfig();
  const existing = await getPassword(config.username);
  if (existing) {
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `A password for "${config.username}" is already stored. Overwrite?`,
      initial: false,
    });
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  const { password } = await prompts({
    type: 'password',
    name: 'password',
    message: `Password for ${config.username}`,
  });
  if (!password) {
    console.log('Aborted (empty password).');
    process.exitCode = 1;
    return;
  }

  await setPassword(config.username, password);
  console.log(`Stored password for "${config.username}" in macOS Keychain (service: siesta).`);
}

async function runLogout(): Promise<void> {
  const { config } = loadConfig();
  stopNag();
  const removed = await deletePassword(config.username);
  await clearState();
  clearLastStamp();
  clearStampLog();
  console.log(removed ? 'Password removed and session cleared.' : 'No password was stored. Session cleared.');
}

function runNagCmd(opts: { stop?: boolean; status?: boolean }): void {
  if (opts.stop) {
    const { stopped, pid } = stopNag();
    console.log(stopped ? `Stopped nag loop (pid ${pid}).` : 'No nag loop was running.');
    return;
  }
  if (opts.status) {
    const pid = readNagPid();
    if (pid) {
      try {
        process.kill(pid, 0);
        console.log(`Nag loop is running (pid ${pid}).`);
      } catch {
        console.log(`Stale pid file for ${pid}; no live process. Run \`siesta nag --stop\` to clean up.`);
      }
    } else {
      console.log('No nag loop running.');
    }
    return;
  }
  const { started, pid } = startNag();
  console.log(started ? `Nag loop started (pid ${pid}).` : `Nag loop was already running (pid ${pid}).`);
}

main().catch((err) => {
  log.error(err);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
