import type { Page } from 'playwright';
import type { Config } from './config.js';
import { log } from './log.js';
import { performLogin } from './stamp.js';

export async function readOvertime(page: Page, config: Config): Promise<string> {
  await ensureOnOvertimePage(page, config);
  const raw = (await page.locator(config.selectors.overtime).first().textContent({ timeout: config.timeout_ms })) ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

async function ensureOnOvertimePage(page: Page, config: Config): Promise<void> {
  if (!isOnOvertimeUrl(page.url(), config.overtime_url)) {
    log.debug(`siesta: navigating to ${config.overtime_url}`);
    await page.goto(config.overtime_url, { waitUntil: 'domcontentloaded' });
  }

  let phase = await waitForLoginOrTable(page, config);
  log.debug(`siesta: initial overtime wait resolved as '${phase}' (url=${page.url()})`);

  if (phase === 'login') {
    await performLogin(page, config);
    // Login often redirects back to the default presence action — force the ZeitDaten action again.
    if (!isOnOvertimeUrl(page.url(), config.overtime_url)) {
      log.debug(`siesta: post-login redirect to ${page.url()}, re-navigating to overtime`);
      await page.goto(config.overtime_url, { waitUntil: 'domcontentloaded' });
    }
    phase = await waitForLoginOrTable(page, config);
    log.debug(`siesta: post-login overtime wait resolved as '${phase}' (url=${page.url()})`);
    if (phase === 'login') {
      throw new Error(
        'Login schlug fehl — Loginseite immer noch sichtbar. Passwort falsch (siesta login) oder Selektoren auf der Anmeldeseite geändert?',
      );
    }
  }
}

function isOnOvertimeUrl(currentUrl: string, overtimeUrl: string): boolean {
  const [base, query] = overtimeUrl.split('?');
  if (!currentUrl.startsWith(base)) return false;
  if (!query) return true;
  // If overtime_url carries an actionName, make sure we're actually on that action.
  const match = /[?&]actionName=([^&]+)/.exec(query);
  if (!match) return true;
  return new RegExp(`[?&]actionName=${match[1]}(?:&|$)`).test(currentUrl);
}

async function waitForLoginOrTable(page: Page, config: Config): Promise<'table' | 'login'> {
  const table = page
    .locator(config.selectors.overtime)
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'table' as const);
  const login = page
    .locator(config.selectors.login_username)
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'login' as const);

  table.catch(() => {});
  login.catch(() => {});

  return Promise.race([table, login]);
}
