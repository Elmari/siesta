import type { Page } from 'playwright';
import type { Config } from './config.js';
import { getPassword } from './credentials.js';
import { log } from './log.js';

// After the content selector wins the visibility race, how long to keep watching
// for a late JS redirect to the auth page before trusting the "logged in" verdict.
const LOGIN_SETTLE_MS = 1500;
// How many times to (re)navigate + resolve before giving up. We submit the login
// form at most once regardless (see `loggedIn` below) so a wrong password can't be
// hammered into a lockout; the extra attempts only absorb mid-navigation flakes.
const MAX_ATTEMPTS = 4;

/**
 * Drive `page` to a state where the real content (presence/overtime) is shown,
 * logging in along the way if the auth form appears.
 *
 * `navigate` (re)loads the target page; it runs on the first attempt and again
 * after every login, because the intranet drops you on a default action after
 * auth rather than back on the page you asked for.
 */
export async function ensureContentOrLogin(
  page: Page,
  config: Config,
  contentSelector: string,
  navigate: () => Promise<void>,
  isOnTarget: () => boolean = () => false,
): Promise<void> {
  let loggedIn = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!isOnTarget()) {
      await navigate();
    }

    let phase: 'content' | 'login';
    try {
      phase = await resolvePhase(page, config, contentSelector);
    } catch (err) {
      // A mid-flight navigation (e.g. the auth redirect firing while we wait) can
      // detach the element we're watching and reject the wait. Retry from scratch.
      if (attempt === MAX_ATTEMPTS) throw err;
      log.debug(`siesta: phase resolution failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${(err as Error).message}`);
      continue;
    }

    log.debug(`siesta: attempt ${attempt} resolved as '${phase}' (url=${page.url()})`);
    if (phase === 'content') return;

    // Still on the login form after we already submitted credentials → don't
    // resubmit (a wrong password would otherwise be tried until lockout).
    if (loggedIn) {
      throw new Error(
        'Login schlug fehl — Loginseite immer noch sichtbar. Passwort falsch (siesta login) oder Selektoren auf der Anmeldeseite geändert?',
      );
    }

    await performLogin(page, config);
    loggedIn = true;
  }

  throw new Error(
    'Login schlug fehl — Loginseite ließ sich nicht laden (Timeout/Navigationsfehler).',
  );
}

/**
 * Decide whether the current page is the auth/login form or the real content page.
 *
 * The intranet serves the presence/overtime HTML — which already contains the
 * content selector — at domcontentloaded and only *then* JS-redirects an expired
 * session to the auth page. A single visibility race can therefore latch onto
 * 'content' off that stale, pre-redirect HTML. So when content wins, we give a
 * late redirect a brief window to surface the login form before trusting it.
 */
export async function resolvePhase(
  page: Page,
  config: Config,
  contentSelector: string,
): Promise<'content' | 'login'> {
  const content = page
    .locator(contentSelector)
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'content' as const);
  const login = page
    .locator(config.selectors.login_username)
    .first()
    .waitFor({ state: 'visible', timeout: config.timeout_ms })
    .then(() => 'login' as const);

  // Swallow the loser's rejection so a slow timeout doesn't surface as unhandled.
  content.catch(() => {});
  login.catch(() => {});

  const phase = await Promise.race([content, login]);
  if (phase === 'login') return 'login';

  // Content won — but it may be stale HTML served just before a JS redirect to auth.
  // Give that late redirect a fixed window to surface the login form before we trust
  // the "logged in" verdict. This costs the happy path one settle timeout, which is
  // cheap next to the browser launch and worth it to never act on a vanishing page.
  const lateLogin = await page
    .locator(config.selectors.login_username)
    .first()
    .waitFor({ state: 'visible', timeout: LOGIN_SETTLE_MS })
    .then(() => true)
    .catch(() => false);
  if (lateLogin) log.debug('siesta: content won the race but auth form appeared shortly after — treating session as expired');
  return lateLogin ? 'login' : 'content';
}

export async function performLogin(page: Page, config: Config): Promise<void> {
  log.info('siesta: session expired — logging in');
  const password = await getPassword(config.username);
  if (!password) {
    throw new Error(
      `No password stored in macOS Keychain for "${config.username}". Run \`siesta login\` first.`,
    );
  }

  await page.locator(config.selectors.login_username).fill(config.username);
  await page.locator(config.selectors.login_password).fill(password);
  await page.locator(config.selectors.login_submit).click();
}
