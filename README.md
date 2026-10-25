# claudetop

A little pixel Claude that lives at the bottom of your screen and shows what Claude Code is doing.

| State | What Claude does |
|---|---|
| **Working** | walks around (or taps away in place) with a "Working…" bubble |
| **Needs you** | bounces and waves: Claude is waiting on a permission or question |
| **Done** | hops and says "Done! ✓" until you've seen it (see below) |
| **Out of credits** | turns grey and deflates (billing / usage-limit errors) |
| **Resting** | sits down and snoozes |

**When "Done" goes back to resting:** if you're already in the Claude Code window when it
finishes, after 10 seconds. If you're somewhere else, it keeps saying "Done!" until you switch to
Claude Code, then rests 5 seconds later. A terminal tab counts as Claude Code when it belongs to
the session or its title looks like a Claude Code title (`✳ topic`, `◑ topic`, or contains "Claude").

## Extras (right-click menu)

- **Panic when done**: when Claude finishes while you're elsewhere, the little Claude sprints back
  and forth across all your monitors, wide-eyed and sweating, until you open Claude Code. Then it
  sighs with relief (dropping and picking up its hard hat, if it has one) and walks home.
- **Hat**: none, a yellow hard hat, a propeller beanie whose propeller spins while it moves, or a
  miner hat with a headlamp: a miner digs down and tunnels instead of walking long distances.
  Or go full **Agent 47**: black suit, red tie, barcode, sneaking at 47 px/s, and his own lines
  ("On a contract…", "Mission accomplished.").
- **Watch TV when you watch videos**: while a video plays, Claude sits down in front of a little
  TV. If Claude Code finishes mid-show, it jumps up and kicks the TV across all your screens.
- **Dance to music**: when music plays (Spotify and other music apps, or anything incl. browser
  videos), Claude puts on headphones and dances with colourful notes floating around.
- **Show on screen**: pick which monitor it lives on (it walks over).
- **Roam across all screens**: wander freely over every monitor, hopping across the edges.

## Lock-in mode

Off by default; turn it on from the right-click menu. When the browser tab in front has an adult
site or keyword in its title, Claude closes that tab (Ctrl+W) and tells you to lock in. How
depends on the hat: no hat slashes a red line through the tab; a hard hat gets thrown at it (and
fetched afterwards); a propeller flies Claude up to bonk it, which knocks the hat off: Claude
drops, gets embarrassed, angry or sad, picks the hat up and flies back; a miner digs down, peeks
out of the ceiling upside down, whacks the tab with a shovel, falls spinning into a hole in the
floor and tunnels back; Agent 47 lobs a remote explosive rubber duck onto the tab and clicks.
It only reads window and tab titles, never what's on screen.

## Install

Run `claudetop Setup <version>.exe`. The wizard asks where to install and offers a desktop
shortcut, connecting to Claude Code (adds hooks to `~/.claude/settings.json`), and starting with
Windows. Uninstalling from Windows Settings removes the hooks again.

The installer isn't code-signed, so Windows SmartScreen may say "Windows protected your PC":
click **More info → Run anyway**.

## Build the installer

```sh
npm install
npm run dist            # -> dist/claudetop Setup <version>.exe
```

If the build fails with "Cannot create symbolic link", turn on Windows Developer Mode, or extract
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z` into a `winCodeSign-2.6.0` folder next to it
(the failing symlinks are macOS-only files).

## Website

`website/` is a static site: open `website/index.html` or upload the folder to any static host.

- **Branding:** name, tagline, colours, your name and links all live in `website/brand.js`.
- **Publishing a release:** `npm run dist`, then
  `npm run release -- --notes "First change; Second change"`. That copies the installer to
  `website/downloads/` and puts the version at the top of the release list (the newest one is what
  the big download buttons point to).

## Develop

```sh
npm install
npm run install-hooks   # points the hooks at this checkout via node
npm start
```

## Using it

- **Hover** over Claude to see each session's status.
- **Drag** to move it. In "Stay in place" mode, the spot is remembered.
- **Right-click** (or use the tray icon) to switch Walk/Stay in place, preview states, start with Windows, or quit.

## How it works

`hooks/report.js` runs on Claude Code hook events and writes one small JSON file per session to
`~/.claude/claudetop/sessions/`. The Electron app watches that folder and picks the most important
state across all sessions: needs you > working > latest of (out of credits / done / error) > resting.

Remove the hooks with `npm run uninstall-hooks`.
