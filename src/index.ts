#!/usr/bin/env node
import 'dotenv/config';
import { basename } from 'node:path';
import { Command } from 'commander';
import prompts from 'prompts';
import { loadConfig, writeSampleConfig } from './config.js';
import { deletePassword, getPassword, setPassword } from './credentials.js';
import { clearState, openSession } from './browser.js';
import { readStatus, stamp, type Presence, type StampResult } from './stamp.js';
import { log } from './log.js';

const ALIAS_TO_TARGET: Record<string, Presence> = {
  moin: 'anwesend',
  ciao: 'abwesend',
  mahlzeit: 'abwesend',
};

async function main(): Promise<void> {
  const invokedAs = basename(process.argv[1] ?? '').replace(/\.[^.]+$/, '');
  if (invokedAs in ALIAS_TO_TARGET) {
    await runStamp(ALIAS_TO_TARGET[invokedAs], parseStampOpts(process.argv.slice(2)));
    return;
  }

  const program = new Command();
  program.name('siesta').description('Stamp presence at intranet without the UI dance').version('0.1.0');

  program
    .command('in')
    .description('clock in (anwesend)')
    .option('--headed', 'show the browser window (debugging)')
    .option('--force', 'click even if already in the target state')
    .action(async (opts) => runStamp('anwesend', opts));

  program
    .command('out')
    .description('clock out (abwesend)')
    .option('--headed', 'show the browser window')
    .option('--force', 'click even if already in the target state')
    .action(async (opts) => runStamp('abwesend', opts));

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
  force?: boolean;
}

function parseStampOpts(argv: string[]): StampOpts {
  return { headed: argv.includes('--headed'), force: argv.includes('--force') };
}

async function runStamp(target: Presence, opts: StampOpts): Promise<void> {
  const { config } = loadConfig();
  const session = await openSession(config, { headed: opts.headed });
  try {
    let result: StampResult;
    if (opts.force) {
      const before = await readStatus(session.page, config);
      const buttonName = target === 'anwesend' ? 'btnPresent' : 'btnAbsent';
      await session.page.locator(`[name="${buttonName}"]`).first().click();
      const after = await readStatus(session.page, config);
      result = { before, after, changed: before !== after };
    } else {
      result = await stamp(session.page, config, target);
    }
    await session.saveState();

    if (!result.changed) {
      console.log(`Schon ${result.before}. Nichts zu tun.`);
    } else {
      console.log(`${result.before} → ${result.after} ✓`);
    }
  } finally {
    await session.close();
  }
}

async function runStatus(opts: { headed?: boolean }): Promise<void> {
  const { config } = loadConfig();
  const session = await openSession(config, { headed: opts.headed });
  try {
    const status = await readStatus(session.page, config);
    await session.saveState();
    console.log(status);
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
  const removed = await deletePassword(config.username);
  await clearState();
  console.log(removed ? 'Password removed and session cleared.' : 'No password was stored. Session cleared.');
}

main().catch((err) => {
  log.error(err);
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
