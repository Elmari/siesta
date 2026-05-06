import type { Page } from 'playwright';
import type { Config } from './config.js';
import { getPassword } from './credentials.js';
import { log } from './log.js';

export type Presence = 'anwesend' | 'abwesend';

export interface StampResult {
  before: Presence | 'unknown';
  after: Presence | 'unknown';
  changed: boolean;
}

export async function readStatus(page: Page, config: Config): Promise<Presence | 'unknown'> {
  await ensureOnPresencePage(page, config);
  const text = (await page.locator('#status').first().textContent({ timeout: config.timeout_ms })) ?? '';
  return parsePresence(text);
}

export async function stamp(page: Page, config: Config, target: Presence): Promise<StampResult> {
  await ensureOnPresencePage(page, config);

  const beforeText = (await page.locator('#status').first().textContent({ timeout: config.timeout_ms })) ?? '';
  const before = parsePresence(beforeText);

  if (before === target) {
    log.info(`siesta: already ${target}; nothing to do`);
    return { before, after: before, changed: false };
  }

  const buttonName = target === 'anwesend' ? 'btnPresent' : 'btnAbsent';
  log.debug(`siesta: clicking [name="${buttonName}"]`);
  await page.locator(`[name="${buttonName}"]`).first().click();

  await page.waitForFunction(
    (expected: string) => {
      const el = document.getElementById('status');
      return !!el && el.textContent?.trim().toLowerCase() === expected;
    },
    target,
    { timeout: config.timeout_ms },
  );

  const afterText = (await page.locator('#status').first().textContent({ timeout: config.timeout_ms })) ?? '';
  const after = parsePresence(afterText);
  return { before, after, changed: before !== after };
}

async function ensureOnPresencePage(page: Page, config: Config): Promise<void> {
  if (!page.url().startsWith(config.presence_url.split('?')[0])) {
    log.debug(`siesta: navigating to ${config.presence_url}`);
    await page.goto(config.presence_url, { waitUntil: 'domcontentloaded' });
  }
  if (await isOnLoginPage(page, config)) {
    await performLogin(page, config);
  }
  await page.waitForSelector('#status', { timeout: config.timeout_ms });
}

async function isOnLoginPage(page: Page, config: Config): Promise<boolean> {
  const url = page.url();
  if (url.startsWith(config.login_url)) return true;
  return (await page.locator('input[name="username"]').count()) > 0
    && (await page.locator('input[name="password"]').count()) > 0;
}

async function performLogin(page: Page, config: Config): Promise<void> {
  log.info('siesta: session expired — logging in');
  const password = await getPassword(config.username);
  if (!password) {
    throw new Error(
      `No password stored in macOS Keychain for "${config.username}". Run \`siesta login\` first.`,
    );
  }

  await page.locator('input[name="username"]').fill(config.username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('#login-button').click();

  await page.waitForURL((url) => !url.toString().startsWith(config.login_url), {
    timeout: config.timeout_ms,
  });
  if (!page.url().startsWith(config.presence_url.split('?')[0])) {
    await page.goto(config.presence_url, { waitUntil: 'domcontentloaded' });
  }
}

function parsePresence(text: string): Presence | 'unknown' {
  const t = text.trim().toLowerCase();
  if (t === 'anwesend') return 'anwesend';
  if (t === 'abwesend') return 'abwesend';
  return 'unknown';
}
