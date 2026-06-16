import type { Page } from 'playwright';
import type { Config } from './config.js';
import { ensureContentOrLogin } from './auth.js';
import { log } from './log.js';

export async function readOvertime(page: Page, config: Config): Promise<string> {
  await ensureOnOvertimePage(page, config);
  const raw = (await page.locator(config.selectors.overtime).first().textContent({ timeout: config.timeout_ms })) ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

async function ensureOnOvertimePage(page: Page, config: Config): Promise<void> {
  // Login drops us on the default presence action, so navigate() forces the
  // ZeitDaten action again on the first pass and after every login.
  await ensureContentOrLogin(
    page,
    config,
    config.selectors.overtime,
    () => {
      log.debug(`siesta: navigating to ${config.overtime_url}`);
      return page.goto(config.overtime_url, { waitUntil: 'domcontentloaded' }).then(() => undefined);
    },
    () => isOnOvertimeUrl(page.url(), config.overtime_url),
  );
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
