# siesta

Stamp yourself in/out at intranet without ever opening the presence page. `moin` to clock in, `mahlzeit` for lunch, `ciao` for end of day. Skips the OIDC dance and a couple of recurring foot-guns. macOS only.

## Install

```bash
git clone <this-repo> ~/IdeaProjects/siesta
cd ~/IdeaProjects/siesta
npm install                        # keytar's postinstall must run — no --ignore-scripts
npx playwright install chromium
npm link                           # exposes siesta / moin / ciao / mahlzeit on $PATH
```

## Setup

```bash
siesta config init                       # writes ~/.config/siesta/config.yaml
$EDITOR ~/.config/siesta/config.yaml     # set username:
siesta login                             # stores your password in Keychain
```

## Daily use

```bash
moin           # clock in
mahlzeit       # clock out for lunch (kicks off the lunch reminder)
moin           # back from lunch
ciao           # end of day
siesta status  # what am I right now?
siesta worked  # how long have I worked today?
```

| Alias | Equivalent | Action |
|---|---|---|
| `moin` | `siesta in` | clock in (anwesend) |
| `ciao` | `siesta out` | clock out (abwesend) |
| `mahlzeit` | `siesta out --nag` | clock out + start lunch reminder loop |

`anwesend` / `abwesend` are the literal intranet states, so they appear verbatim in the output.

Flags on stamp commands:

- `--headed` — visible browser, useful when something breaks.
- `--dry-run` — full flow including login and selectors, but no click. Useful after upstream UI changes.

## Guards

All hard, no override flag:

- **No stamping 21:00–06:00.** Writes only; `status` and `worked` always work.
- **No re-clocking in within 60 s of clocking out.** Catches accidental double-clicks and too-short breaks.
- **No `moin` once today's accumulated work time is ≥ 10h 15min.**
- **Already in target state?** No-op with a friendly message — nothing sent to the server.

When a guard fires you get a single line and a clean exit — no stack trace.

## `siesta worked`

Reads the local stamp log and prints today's totals. Offline, no browser:

```
✅ anwesend seit 09:42
Heute gearbeitet: 4h 18min (1 Pause davor, noch 5h 57min bis 10h 15min)
```

```
🌙 abwesend (zuletzt abgemeldet 12:14)
Heute gearbeitet: 3h 12min (noch 7h 3min bis 10h 15min)
```

`siesta status` is the same idea but goes to the server for the canonical presence.

## Background nags

Both run as detached children, both die on clock-out and on `siesta logout`.

**Lunch nag** — started by `mahlzeit`. After `nag.delay_minutes` it pings you every `nag.interval_minutes` until you clock back in.

**Cap nag** — started by `moin`. Notifies 15 min before, 5 min before, at, and every 5 min after the 10h 15min cap. Before each warning it re-reads the presence page, so a UI-side clock-out kills the loop instantly instead of triggering a wrong nag.

```bash
siesta nag           # manual start of the lunch nag
siesta nag --status  # is one running?
siesta nag --stop    # kill it
```

The cap nag has no manual command — it lives strictly with `moin` / `ciao`.

Tune cadence + sound in `~/.config/siesta/config.yaml`:

```yaml
nag:
  enabled: true
  delay_minutes: 60
  interval_minutes: 10
  sound: Glass         # any name from /System/Library/Sounds, or "" for silent
```

## Optional: launchd auto-stamp

Clock in at 09:00. Save as `~/Library/LaunchAgents/local.siesta.in.plist`:

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

Use `which moin` to confirm the path matches your install.

## Internals

### State files

All under `~/Library/Application Support/siesta/`:

| File | Purpose |
|---|---|
| `state.json` | Playwright cookies — keeps you logged in. |
| `last-stamp.json` | Latest presence + timestamp; drives the 60-s break check and the cap-nag's cheap path. |
| `stamps.jsonl` | Append-only log of stamp events; drives `siesta worked`. |
| `nag.{pid,log}` / `cap-nag.{pid,log}` | Per-nag pid file + log. |

`siesta logout` clears the Keychain entry, `state.json`, `last-stamp.json`, and `stamps.jsonl`. The pid/log files stay.

### Stamp flow

1. Launches headless Chromium with `state.json` cookies.
2. Navigates to the presence URL.
3. Races `#status` (already in) vs. `input[name="username"]` (login form). If login wins, fills credentials and submits; the race re-runs once. A second login result throws a clear error instead of a silent timeout.
4. Reads `#status` and reconciles local state — if the server disagrees with `last-stamp.json`, appends a synthetic event with `ts = now` so UI-side stamps are recorded (approximate to the minute).
5. Clicks the appropriate button (or no-ops) and persists cookies.

The synthetic-event approximation drifts by a few minutes if you alternate the UI and the CLI a lot; for CLI-first usage the drift is negligible.

### Debugging

```bash
LOG_LEVEL=debug moin --headed     # visible browser + every step
PWDEBUG=1 siesta in               # Playwright Inspector (step manually)
moin --dry-run                    # full flow, no click
```

Login selectors live in `performLogin` ([src/stamp.ts](src/stamp.ts)) — adjust if the upstream form changes.

### Credentials

Keychain service `siesta`, account = your username. Inspect:

```bash
security find-generic-password -s siesta -a <username>
```

`siesta logout` removes it.
