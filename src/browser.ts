import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import type { Config } from './config.js';
import { log } from './log.js';
import { statePath } from './paths.js';

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  saveState: () => Promise<void>;
  close: () => Promise<void>;
}

export async function openSession(config: Config, opts: { headed?: boolean }): Promise<Session> {
  const browser = await chromium.launch({ headless: !opts.headed && config.headless });
  const sp = statePath();
  const storageState = existsSync(sp) ? sp : undefined;
  if (storageState) log.debug(`siesta: restoring browser state from ${sp}`);

  const context = await browser.newContext({ storageState });
  context.setDefaultTimeout(config.timeout_ms);
  const page = await context.newPage();

  const saveState = async () => {
    mkdirSync(dirname(sp), { recursive: true });
    await context.storageState({ path: sp });
    log.debug(`siesta: saved browser state to ${sp}`);
  };

  const close = async () => {
    await context.close();
    await browser.close();
  };

  return { browser, context, page, saveState, close };
}

export async function clearState(): Promise<void> {
  const sp = statePath();
  if (existsSync(sp)) {
    writeFileSync(sp, '{}', 'utf8');
  }
}

export function loadStateRaw(): unknown {
  const sp = statePath();
  if (!existsSync(sp)) return null;
  try {
    return JSON.parse(readFileSync(sp, 'utf8'));
  } catch {
    return null;
  }
}
