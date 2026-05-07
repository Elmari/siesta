# siesta

CLI presence-stamping for intranet — `moin`, `ciao`, `mahlzeit`.

Skips the OIDC dance and the bad UI. One command, one Playwright headless run, done.

## Install

macOS only.

```bash
git clone <this-repo> ~/IdeaProjects/siesta
cd ~/IdeaProjects/siesta
npm install                        # keytar needs its postinstall — do NOT use --ignore-scripts
npx playwright install chromium    # one-time browser download
npm link                           # exposes siesta / moin / ciao / mahlzeit on your PATH
```

## Setup

```bash
siesta config init       # writes ~/.config/siesta/config.yaml
$EDITOR ~/.config/siesta/config.yaml   # set `username:` to your intranet ID
siesta login             # prompts for password, stores it in macOS Keychain
```

## Daily use

```bash
moin          # clock in (anwesend)
mahlzeit      # clock out for lunch (abwesend, with reminder loop)
moin          # back from lunch
ciao          # end of day (abwesend)
siesta status # what am I right now?
siesta worked # how long have I worked today?
```

The four CLI aliases map to:

| Alias | Equivalent | Action |
|---|---|---|
| `moin` | `siesta in` | clock in (anwesend) |
| `ciao` | `siesta out` | clock out (abwesend) |
| `mahlzeit` | `siesta out --nag` | clock out and start the lunch reminder loop |

`anwesend` and `abwesend` (German for "present" / "absent") are the actual states the intranet system uses, so they show up verbatim in the output.

### Common flags

- `--headed` — open a visible Chromium window instead of running headless. Useful when something breaks and you want to see why.
- `--dry-run` — go through the full flow (login, page navigation, selector resolution, even a visibility check on the would-be-clicked button) but do **not** click. Handy after the intranet UI changes.

## Guard rails

A few things are blocked outright (no override flag, no `--force` — those are gone on purpose):

- **No stamping between 21:00 and 06:00.** Catches late-night mistakes; affects writes only, `siesta status` and `siesta worked` always work.
- **No re-clocking in within 60 s of clocking out.** A break shorter than the configured minimum is rejected.
- **No `moin` once you've already worked 10h 15min today.** The daily cap is hard-blocked at the entry point.
- **Already in the target state?** `moin` while `anwesend` (or `ciao` while `abwesend`) is a no-op with a friendly message — no second click sent to the server.

When a guard fires you get a one-line message and a clean exit. No stack trace, no exit 1.

## `siesta worked`

Reads the local stamp log (`~/Library/Application Support/siesta/stamps.jsonl`) and prints today's totals. Offline, no browser roundtrip:

```
✅ anwesend seit 09:42
Heute gearbeitet: 4h 18min (1 Pause davor, noch 5h 57min bis 10h 15min)
```

```
🌙 abwesend (zuletzt abgemeldet 12:14)
Heute gearbeitet: 3h 12min (noch 7h 3min bis 10h 15min)
```

`siesta status` is the same idea but goes to the server and prints the canonical presence with a coloured badge.

## Lunch nag

When you clock out via `mahlzeit`, siesta forks a detached background process that:

1. Sleeps for `nag.delay_minutes` (default: 60).
2. Then every `nag.interval_minutes` (default: 10), checks your status.
3. As long as you're still `abwesend`, fires a macOS notification reminding you to clock back in.
4. As soon as you're `anwesend` again — via `moin`, the intranet UI, or any other path — the loop exits cleanly.

The loop is **always** killed when you `moin` / `siesta in`, so you never get a nag for a pause that has already ended.

```bash
siesta nag           # start the loop manually
siesta nag --status  # is one running?
siesta nag --stop    # kill it
```

Tune the cadence in `~/.config/siesta/config.yaml`:

```yaml
nag:
  enabled: true
  delay_minutes: 60
  interval_minutes: 10
  sound: Glass         # any name from /System/Library/Sounds, or "" for silent
```

Logs go to `~/Library/Application Support/siesta/nag.log`.

## Cap nag

When you clock in (`moin`), siesta also forks a **cap-nag** in the background that fires a notification 15 min before the 10h 15min mark, then 5 min before, then at the cap, and every 5 min while you're over it — until you clock out.

Before each notification the cap-nag opens a fresh headless session, reads the server status, and reconciles local state with the server. If you clocked out via the UI, the loop sees that and exits without nagging.

Stamping out (`ciao` / `mahlzeit`) kills the cap-nag immediately; `siesta logout` does too. Logs go to `~/Library/Application Support/siesta/cap-nag.log`.

The 10h 15min cap reuses `nag.sound` from the config — no extra setup.

### Server reconciliation

The lunch-nag and the cap-nag both depend on the local stamp log being accurate. To keep it that way, **every server read** (i.e. every `siesta status`, every stamp command, every cap-nag check) reconciles: if the server's reported presence differs from `last-stamp.json`, siesta appends a synthetic event with `ts = now` and updates `last-stamp.json`. So a stamp made via the intranet UI gets picked up by the next siesta invocation that hits the page.

The synthetic event is stamped at the time of detection, not the original UI click — so total worked time can be off by minutes if you alternate between the UI and the CLI a lot. For typical CLI-first usage the drift is negligible.

## State files

Everything lives under `~/Library/Application Support/siesta/`:

| File | Purpose |
|---|---|
| `state.json` | Playwright cookie/storage state — keeps you logged in across runs. |
| `last-stamp.json` | Most recent presence + timestamp; used for the 60-s break check and as the cheap state for the cap-nag. |
| `stamps.jsonl` | Append-only log of every stamp event today (and historically). Drives `siesta worked`. |
| `nag.pid` / `nag.log` | Lunch-nag pid file + log. |
| `cap-nag.pid` / `cap-nag.log` | Cap-nag pid file + log. |

`siesta logout` removes the password from Keychain and clears `state.json`, `last-stamp.json`, and `stamps.jsonl`. The pid/log files are left in place.

## How it works

1. Launches headless Chromium with cached cookies from `state.json`.
2. Navigates to the presence URL.
3. If the session is dead, races between `#status` (we're already in) and `input[name="username"]` (the OIDC login form) — whichever wins decides the next step. On `'login'`, fills the form with the password from Keychain and submits. The race repeats once after submit so a wrong password surfaces as a clear error instead of a silent timeout.
4. Reads `#status` text and reconciles the local stamp log.
5. If already in the target state → no-op. Otherwise clicks `[name="btnPresent"]` or `[name="btnAbsent"]` and waits for `#status` to flip.
6. Persists cookies for the next call.

## Debugging

```bash
LOG_LEVEL=debug moin --headed     # show every step + the visible browser window
PWDEBUG=1 siesta in               # full Playwright Inspector (you'll need to step through manually)
moin --dry-run                    # full flow without the click
```

If the login page selectors change, edit `performLogin` in [src/stamp.ts](src/stamp.ts).

## Credentials

The password lives in macOS Keychain under service `siesta`, account = your intranet username. Inspect via:

```bash
security find-generic-password -s siesta -a <your.username>
```

`siesta logout` removes the keychain entry and clears all cached state.

## Optional: launchd auto-stamp

Clock in at 09:00 every weekday. Save as `~/Library/LaunchAgents/local.siesta.in.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.siesta.in</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/moin</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/local.siesta.in.plist
```

Run `which moin` to make sure the path matches your install.
