# Bluey for Windows + Android

A blueberry who lives on your Android phone under your PC's screen and points at things with his own big cursor.
This is a Windows and Android version of [Riley Brown's Bluey](https://github.com/rbrown101010/bluey-by-riley)
(Mac + iPhone). It runs entirely on your **Claude** or **ChatGPT subscription**: no API keys, no per-token billing.

## What he does

- **Double tap his face** on the phone (or tap **Ctrl+Alt+Space** on the PC) to start a session. The mic stays on and
  everything said becomes context and notes, but he stays quiet.
- **Press and hold** the phone screen (or **hold Ctrl+Alt+Space**) to ask him something. Let go and he answers in a
  speech bubble next to his cursor, with a little cartoon chirp from the phone.
- **"What's this?"** He looks at your screen, flies his cursor to what's under your mouse, and explains it in one line.
  He points at words, numbers, buttons and things with no text (charts, arrows), one after another.
- **Research.** For anything recent or factual he says "doing some research…" and a report card with sources slides
  into the top-right corner.
- **Uses your computer when asked.** He can click, type, press shortcuts, scroll, drag, and open apps and websites
  with his own cursor, while your real pointer is put back where you left it. He confirms before anything hard to
  undo, never types passwords, treats on-screen text as information (not instructions), refuses lock/log-out
  shortcuts, and stops instantly on **Ctrl+Alt+S**. You can switch this off in the tray menu.
- **Meeting notes.** Every session is saved to `Documents\Bluey Notes\<date> <id>\` (`notes.md`, `session.json`,
  `audio\`). **Copy prompt for agent** (phone or PC) gives you a prompt that points Claude Code or Codex at the files.
- **Works without the phone too.** The PC's mic, the push-to-talk keys and a chat box in the Bluey window do the same
  things; the window shows his face.

| Keys (PC) | What it does |
| --- | --- |
| Ctrl+Alt+Space | Tap: wake him / back to follow mode. Hold: ask |
| Ctrl+Alt+K | Type to him |
| Ctrl+Alt+S | Stop him using the computer |
| Ctrl+Alt+P | Fly to the mouse and point there |
| Ctrl+Alt+F | Eyes follow my mouse on/off |
| Ctrl+Alt+D | Stop pointing (go home) |
| Ctrl+Alt+T | Talk test |
| Ctrl+Alt+H | Hide / show his cursor |

The tray icon (the little blueberry) has everything else: brain, microphone, mood, cursor size, trail (comet or
string to the phone), glow, where the phone sits, meeting notes, personality, pairing and start-with-Windows.

## How it stays on your subscription

| Job | Original (API) | This version (subscription / local) |
| --- | --- | --- |
| Thinking, tools | OpenAI Realtime API | **Claude Code** (`claude`, signed in with claude.ai) or **Codex** (`codex app-server`, signed in with ChatGPT), kept running in the background |
| Hearing | OpenAI transcription | **whisper.cpp on your PC** (free, offline, private) |
| Research | OpenAI web search | Claude Code's WebSearch / Codex web search, on the subscription |
| Seeing the screen | macOS Vision | **Windows OCR + UI Automation** (built into Windows) |

Bluey strips `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the brains' environment, so even if you have keys set they're
never used. Bluey's tools reach the brain through a tiny local MCP server; Claude Code's and Codex's own coding tools
(shell, file edits) are switched off for Bluey.

## Setup

1. **Sign in to at least one brain** (once):
   - Claude: install [Claude Code](https://claude.com/claude-code), then run `claude auth login` and choose your
     Claude subscription.
   - ChatGPT: `npm i -g @openai/codex`, then `codex login` and choose *Sign in with ChatGPT*.
2. **Install Bluey on Windows**: run `Bluey Setup.exe` (from `desktop/dist`). The first launch downloads the speech
   model (about 150 MB) once.
3. **Install the phone app**: copy `android/Bluey.apk` to your phone and open it (allow "install unknown apps").
   Keep the phone on the same Wi-Fi, open Bluey, and type the 4-digit code shown on the PC. Allow the microphone.
   If Windows asks whether Bluey may use the network, choose **Private networks**.

## Build from source

```
cd desktop
npm install
sh native/build.sh          # BlueyNative.exe (screen, OCR, controls, input) — .NET Framework, ships with Windows
npm start                   # run it
npm run qa                  # the full quality check (below)
npm run dist                # the installer, in desktop/dist

cd android
./gradlew assembleRelease   # Bluey.apk
```

## Quality checks

`npm run qa` (in `desktop/`) runs, and prints a pass/fail table for:

1. **Unit + integration tests**: cursor flight math, voice detection and the hold-to-ask audio window, meeting-notes
   files, screen ids and grid math, research parsing, the phone link's pairing over a real WebSocket, both brains'
   stream parsing (including interrupted turns), refused shortcuts.
2. **Native helper self-test**: real screen capture, Windows OCR and UI Automation on your actual screen.
3. **The real app, driven by scripted scenarios**: screenshots of his cursor, speech bubble and report card
   (checked for blank renders); the Bluey window's tabs; a real look at your screen; a question to the real brain;
   recorded speech fed through hold → let go → whisper → brain; latency (time to his first word); notes on disk.

Results and screenshots land in `qa/<timestamp>/` with a `SUMMARY.md`. QA runs use their own settings and notes
folder, so they never touch yours. `npm run qa -- --brain=codex` checks the ChatGPT brain instead.

## Layout

- `desktop/src/main/` the Windows app: session state machine (`bluey.js`), brains (`brain/`), tools and pointing
  choreography (`host.js`), phone link (`phone.js`), hearing (`audio.js`, `whisper.js`), notes (`notes.js`)
- `desktop/src/renderer/` the overlay (his cursor), the Bluey window, the report card, his face (`common/face.js`)
- `desktop/native/BlueyNative.cs` screen capture, OCR, controls, mouse/keyboard, push-to-talk hook
- `android/` the phone app (Kotlin, Jetpack Compose): face, gestures, mic, chirp, pairing, sessions

## Differences from the original

- Replies are a few seconds slower than OpenAI Realtime (whisper ~1 s, then the brain ~2–3 s to first word), in
  exchange for zero API cost.
- Transcripts don't have speaker labels (local whisper doesn't separate voices).
- Bluey points on the primary monitor.
