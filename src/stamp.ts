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

export async function stamp(
  page: Page,
  config: Config,
  target: Presence,
  opts: { dryRun?: boolean } = {},
): Promise<StampResult> {
  await ensureOnPresencePage(page, config);

  const beforeText = (await page.locator('#status').first().textContent({ timeout: config.timeout_ms })) ?? '';
  const before = parsePresence(beforeText);

  if (before === target) {
    log.info(`siesta: already ${target}; nothing to do`);
    return { before, after: before, changed: false };
  }

  const buttonName = target === 'anwesend' ? 'btnPresent' : 'btnAbsent';

  if (opts.dryRun) {
    // Dry-run: ensure the button is actually attached/visible so we'd know if a selector broke,
    // but don't click it.
    await page.locator(`[name="${buttonName}"]`).first().waitFor({ state: 'visible', timeout: config.timeout_ms });
    log.info(`siesta: [dry-run] would click [name="${buttonName}"] — skipping`);
    return { before, after: before, changed: false };
  }

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
    log.debug(`siesta: after goto, page.url() = ${page.url()}`);
  }

  let phase = await waitForLoginOrStatus(page, config);
  log.debug(`siesta: initial wait resolved as '${phase}' (url=${page.url()})`);

  if (phase === 'login') {
    await performLogin(page, config);
    phase = await waitForLoginOrStatus(page, config);
    log.debug(`siesta: post-login wait resolved as '${phase}' (url=${page.url()})`);
    if (phase === 'login') {
      throw new Error(
        'Login schlug fehl — Loginseite immer noch sichtbar. Passwort falsch (siesta login) oder Selektoren auf der Anmeldeseite geändert?',
      );
    }
  }
}

async function waitForLoginOrStatus(page: Page, config: Config): Promise<'status' | 'login'> {
  const status = page
    .locator('#status')
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'status' as const);
  const login = page
    .locator('input[name="username"]')
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'login' as const);

  // Swallow the loser's rejection so a slow timeout doesn't surface as unhandled.
  status.catch(() => {});
  login.catch(() => {});

  return Promise.race([status, login]);
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
}

function parsePresence(text: string): Presence | 'unknown' {
  const t = text.trim().toLowerCase();
  if (t === 'anwesend') return 'anwesend';
  if (t === 'abwesend') return 'abwesend';
  return 'unknown';
}
