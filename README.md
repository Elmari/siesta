# siesta

CLI presence-stamping for intranet — `moin`, `ciao`, `mahlzeit`.

Skips the OIDC dance + bad UI. One command, one Playwright headless run, done.

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
moin          # einstempeln (anwesend)
mahlzeit      # ausstempeln zur Mittagspause
moin          # zurück aus der Pause
ciao          # Feierabend
siesta status # was bin ich gerade?
```

All four commands are equivalent to:

| Alias | Equivalent | Action |
|---|---|---|
| `moin` | `siesta in` | clock in (anwesend) |
| `ciao` | `siesta out` | clock out (abwesend) |
| `mahlzeit` | `siesta out --nag` | clock out (abwesend) — Mittag-flavoured, starts nag loop |

Double-stamp guard is built in: if you're already `anwesend` and run `moin`, it noops with a friendly message. Pass `--force` to click anyway.

## Lunch nag

When you stamp out via `mahlzeit`, siesta forks a detached background process that:

1. Sleeps for `nag.delay_minutes` (default: 60).
2. Then every `nag.interval_minutes` (default: 10), checks your status.
3. While you're still `abwesend`, fires a macOS notification reminding you to clock back in.
4. As soon as you're `anwesend` again — via `moin`, the UI, or any other path — the loop exits cleanly.

The loop is **always** killed when you `moin`/`siesta in`, so you never get a nag for a pause that's already over.

```bash
siesta nag           # start the loop manually
siesta nag --status  # is one running?
siesta nag --stop    # kill it
```

Tune cadence in `~/.config/siesta/config.yaml`:

```yaml
nag:
  enabled: true
  delay_minutes: 60
  interval_minutes: 10
  sound: Glass         # any name from /System/Library/Sounds, or "" for silent
```

Logs from the background loop go to `~/Library/Application Support/siesta/nag.log`.

## How it works

1. Launches headless Chromium with cached cookies from `~/Library/Application Support/siesta/state.json`.
2. Navigates to the presence URL.
3. If the session is dead, fills the OIDC login form (`#login-button` → JS click) using the password from Keychain, then continues.
4. Reads `#status` div text.
5. If already in target state → exit early. Otherwise clicks `[name="btnPresent"]` or `[name="btnAbsent"]` and waits for `#status` to flip.
6. Persists cookies for the next call.

## Debugging

```bash
LOG_LEVEL=debug moin --headed     # show what's happening
PWDEBUG=1 siesta in               # full Playwright Inspector
```

If the login page changes selectors, adjust [src/stamp.ts](src/stamp.ts) (`performLogin`).

## Credentials

Password lives in macOS Keychain under service `siesta`, account = your username. Inspect via:

```bash
security find-generic-password -s siesta -a <your.username>
```

Remove with `siesta logout` (clears keychain entry + stored cookies).

## Optional: launchd auto-stamp

Stamp in at 09:00, out at 17:30. Save as `~/Library/LaunchAgents/local.siesta.in.plist`:

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

`launchctl load ~/Library/LaunchAgents/local.siesta.in.plist`.

(Adjust path — `which moin` to find the right one for your install.)
