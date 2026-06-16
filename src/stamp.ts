import type { Page } from 'playwright';
import type { Config } from './config.js';
import { ensureContentOrLogin } from './auth.js';
import { log } from './log.js';
import { reconcileFromServer } from './workLog.js';

export type Presence = 'anwesend' | 'abwesend';

export interface StampResult {
  before: Presence | 'unknown';
  after: Presence | 'unknown';
  changed: boolean;
}

export async function readStatus(page: Page, config: Config): Promise<Presence | 'unknown'> {
  await ensureOnPresencePage(page, config);
  const text = (await page.locator(config.selectors.status).first().textContent({ timeout: config.timeout_ms })) ?? '';
  const observed = parsePresence(text);
  if (reconcileFromServer(observed)) {
    log.info(`siesta: reconciled local state from server — observed '${observed}'`);
  }
  return observed;
}

export async function stamp(
  page: Page,
  config: Config,
  target: Presence,
  opts: { dryRun?: boolean } = {},
): Promise<StampResult> {
  await ensureOnPresencePage(page, config);

  const beforeText = (await page.locator(config.selectors.status).first().textContent({ timeout: config.timeout_ms })) ?? '';
  const before = parsePresence(beforeText);
  if (reconcileFromServer(before)) {
    log.info(`siesta: reconciled local state from server — observed '${before}' before stamp`);
  }

  if (before === target) {
    log.info(`siesta: already ${target}; nothing to do`);
    return { before, after: before, changed: false };
  }

  const buttonSelector = target === 'anwesend' ? config.selectors.btn_present : config.selectors.btn_absent;

  if (opts.dryRun) {
    // Dry-run: ensure the button is actually attached/visible so we'd know if a selector broke,
    // but don't click it.
    await page.locator(buttonSelector).first().waitFor({ state: 'visible', timeout: config.timeout_ms });
    log.info(`siesta: [dry-run] would click ${buttonSelector} — skipping`);
    return { before, after: before, changed: false };
  }

  log.debug(`siesta: clicking ${buttonSelector}`);
  await page.locator(buttonSelector).first().click();

  await page.waitForFunction(
    ({ statusSel, expected }: { statusSel: string; expected: string }) => {
      const el = document.querySelector(statusSel);
      return !!el && el.textContent?.trim().toLowerCase() === expected;
    },
    { statusSel: config.selectors.status, expected: target },
    { timeout: config.timeout_ms },
  );

  const afterText = (await page.locator(config.selectors.status).first().textContent({ timeout: config.timeout_ms })) ?? '';
  const after = parsePresence(afterText);
  return { before, after, changed: before !== after };
}

async function ensureOnPresencePage(page: Page, config: Config): Promise<void> {
  await ensureContentOrLogin(
    page,
    config,
    config.selectors.status,
    () => {
      log.debug(`siesta: navigating to ${config.presence_url}`);
      return page.goto(config.presence_url, { waitUntil: 'domcontentloaded' }).then(() => {
        log.debug(`siesta: after goto, page.url() = ${page.url()}`);
      });
    },
    () => page.url().startsWith(config.presence_url.split('?')[0]),
  );
}

function parsePresence(text: string): Presence | 'unknown' {
  const t = text.trim().toLowerCase();
  if (t === 'anwesend') return 'anwesend';
  if (t === 'abwesend') return 'abwesend';
  return 'unknown';
}
