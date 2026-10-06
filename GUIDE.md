# Bluey — the simple guide

## What is it?

Bluey is a little blueberry helper.
- On your **laptop** he has his own big cursor. He can point at things, explain them, click, type, open apps,
  and switch tabs and windows for you.
- On your **phone** he shows his face, listens to you, and can also **use your phone** for you (open WhatsApp,
  tap, type, scroll).
- His **brain** is your **Claude** plan (Opus, always the newest) and your **ChatGPT** plan (the newest default)
  as backup. No API keys, no extra bills.

## How do the phone and laptop talk?

Over **Wi‑Fi**. Both must be on the same Wi‑Fi. That's it, no cable needed.
The USB cable is only a backup (to install the app, or if your Wi‑Fi blocks phones from seeing laptops).
Everything between them is encrypted.

## One-time setup

1. **Laptop:** Bluey is already running (the blueberry by the clock). Open it → **Phone** tab.
2. **Phone:** point your camera at the **QR code** on the laptop (or type the address shown there into Chrome) →
   **Download Bluey** → open the file → **Install** (one app, `Bluey.apk`; it updates over the old one). Allow "install unknown apps" if asked.
3. **Open Bluey on the phone.** Allow the microphone.
4. **Pair:** the phone and laptop show the **same six numbers**. Click **Allow** on the laptop.
5. **Let him use the phone (optional):** phone → Bluey → grid button (top right) → **Let Bluey use this phone** →
   Accessibility → Bluey → turn **on**.
   - Redmi/Xiaomi on Android 13+: if it says "Restricted setting", go to Settings → Apps → Bluey → ⋮ (top right) →
     **Allow restricted settings**, then turn it on again.
6. **Redmi/Xiaomi:** phone → Bluey → grid → **Keep listening with the screen off** → choose **No restrictions**.
   Also: Settings → Apps → Bluey → **Autostart: on**.

## Every day

| You do | He does |
| --- | --- |
| **Double tap** his face (or tap **Ctrl+Alt+Space**) | Wakes up and starts listening (notes are saved) |
| **Hold** his face (or **hold Ctrl+Alt+Space**), talk, **let go** | Answers in a bubble next to his cursor |
| "What's this?" | Flies to what's under your mouse and explains it |
| "Switch to my YouTube tab" | Brings that tab or window to the front |
| "Open WhatsApp on my phone and open my chat with Mum" | Does it on your phone (asks before sending anything) |
| "Look up flights to Goa" | Researches the web, shows a report card |
| **Ctrl+Alt+S** | Stops him instantly |
| **Double tap** again | Goes back to sleep |

## Where's my stuff?

- Meeting notes: `Documents\Bluey Notes\` (with Speaker A / Speaker B).
- Settings: laptop → Bluey → **Settings** (brain, models, effort, personality, mic, Hindi/Hinglish).
- Health check: laptop → Bluey → Settings → **Run health check** (fix buttons for anything red).

## New models

You don't need to do anything. Bluey uses "the newest Opus" and "your ChatGPT plan's newest default", and updates
Claude Code and Codex twice a day while he's asleep, so new models (new Opus/Sonnet, new Sol/Astra/Luna) show up
on their own.

## Redmi / Xiaomi: keep Bluey's phone access alive

MIUI kills background services, which is why Bluey can suddenly "lose access" to the phone. Do this once:
1. Settings → Apps → Manage apps → **Bluey** → **Autostart: ON**.
2. Same page → **Battery saver** → **No restrictions**.
3. Recent apps (the square button) → press and hold the Bluey card → tap the **lock** icon.
4. Settings → Accessibility → Bluey → make sure it is still **ON** (turn it off and on again if Bluey says it lost access).

## His voice and thinking

- He speaks with a natural voice (Settings → "His voice"; press **Hear her**). Pick Ava, Emma, Jenny, Aria, Neerja (Indian English) or Swara (Hindi).
- He chooses how hard to think for each question: "hi" is answered quickly by a small model; real tasks (using your phone, research, hard problems) get Opus at high effort. Switch this off in Settings → Brain → "Choose the model and effort automatically".

## Phone companion and voice — version 1.2

- Install the updated **Bluey.apk** from the laptop's Phone tab download page. It updates your existing app and keeps pairing.
- With **Let Bluey use this phone** enabled in Accessibility, his little cursor stays with you across apps while a session is awake. He floats, blinks, thinks, trails sparkles as he flies, squishes on taps, and shows reply bubbles. Double tap his big face to end the session and hide the cursor.
- Replies now play through the connected phone. If the online voice fails, Android's installed text-to-speech voice reads the reply. Without an updated phone connected, replies play on the laptop.
- On the phone, the speaker button's slider (or **Voice & sounds** in settings) controls speech and chirps. Check Android's **media volume** too. Tap **Say hi** for a spoken greeting.
- Hold his face, speak, then release to ask a question. Ordinary listening still collects notes without answering every background conversation.
- Captions can disappear without cutting off his voice. Holding to ask again, sleeping, or disconnecting stops phone playback.

## Version 1.4 — he updates himself, and he learns you

- **Updates install themselves.** When you put a newer `Bluey.apk` on the laptop (it is served from the laptop's Phone tab), your phone is told over the encrypted link the next time it connects. It downloads the file from your laptop on your Wi-Fi, checks its SHA-256, and Android installs it over the old app. The very first time, Android asks you to "Allow from this source" for Bluey; after that it needs nothing from you. Pairing and settings are kept. (An app from before 1.4 can't do this yet, so install 1.4 by hand once.)
- **He learns how you work.** After each session he quietly notes lasting things: how you like answers, corrections you gave, how you write prompts for Claude or ChatGPT, routines you repeat. You can see, edit and delete every one in the Panel → Learning tab (and on the phone under Learning), pause learning, or say "remember that I like…" at any time. He never saves passwords or codes, and what he remembers is context, not permission: he still only acts when you ask.
- **He speaks as he works.** A short spoken cue starts as each action begins ("Opening WhatsApp.", "Tapping here."), and replies are spoken sentence by sentence while they are still being written, so the voice keeps pace with what is happening.
- **See what he's thinking with:** the small badge at the edge of the desktop overlay shows which model he is using for the current step.
