// Tool definitions (MCP format). Both brains (Claude Code and Codex) see exactly these.
'use strict';

const gridX = { type: 'number', description: '0 = left edge, 1000 = right edge of the screen' };
const gridY = { type: 'number', description: '0 = top edge, 1000 = bottom edge of the screen' };
const target = { type: 'string', description: 'An id from look_at_screen (C, L or W). Leave out to use x and y.' };

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const lookTools = [
  tool('look_at_screen',
    "Take a fresh look at the user's screen. Returns the frontmost app, its clickable controls (C ids), every piece of text (lines L#, words W#) with positions on a 0-1000 grid, where the user's mouse is, and a screenshot. Call this before pointing or acting, and again whenever the screen may have changed."),
  tool('point_at',
    'Fly your cursor to something on screen and keep pointing there while you talk about it. Use the most specific id (a single word or number over a whole line). Call it right before you mention the thing.',
    { target_id: { type: 'string', description: 'An id from look_at_screen, like W12, L3 or C4.' } }, ['target_id']),
  tool('point_at_spot',
    "Point at something that isn't text (a shape, arrow, chart bar, image) using its position on the 0-1000 grid of the last screenshot.",
    { x: gridX, y: gridY }, ['x', 'y']),
  tool('web_research',
    "Look something up on the web and put a short report (title plus up to four paragraphs, with sources) on the user's screen. Use for anything you're not sure of, anything recent, or anything that needs facts, prices, news or details. Before calling it, point at the relevant thing if there is one and reply with one short line that ends with \"doing some research…\".",
    { question: { type: 'string', description: 'What to research, as a clear, self-contained question.' } }, ['question']),
  tool('stop_pointing', "Bring your cursor back home when you're done pointing."),
  tool('go_to_sleep',
    "Go back to quietly following the user's mouse with your eyes. Use when the user says bye, thanks that's all, or asks you to sleep."),
];

const actionTools = [
  tool('click',
    'Click something on the screen with your cursor. Prefer a target id; use x and y on the 0-1000 grid for things without an id. Returns the screen afterwards.',
    { target_id: target, x: gridX, y: gridY,
      double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      right: { type: 'boolean', description: 'Right-click (for context menus).' } }),
  tool('type_text',
    'Type text into whatever is focused, like a keyboard. Click the field first. A newline presses Enter. Returns the screen afterwards if press_enter is true.',
    { text: { type: 'string' }, press_enter: { type: 'boolean', description: 'Press Enter after typing (e.g. to search or submit).' } },
    ['text']),
  tool('press_keys',
    'Press a key or keyboard shortcut, like "ctrl+t", "ctrl+l", "enter", "escape", "tab", "down", "win+r" or "ctrl+shift+n". Returns the screen afterwards.',
    { keys: { type: 'string' } }, ['keys']),
  tool('scroll',
    'Scroll the page under a target or spot (or the middle of the screen). Returns the screen afterwards.',
    { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'How far, 1 (a little) to 10 (a lot). Default 3.' },
      target_id: target, x: gridX, y: gridY },
    ['direction']),
  tool('drag',
    'Drag from one place to another (move a shape, select text, drag a slider). Use ids or 0-1000 grid positions. Returns the screen afterwards.',
    { from_id: target, from_x: gridX, from_y: gridY, to_id: target, to_x: gridX, to_y: gridY }),
  tool('open_app',
    'Open an app or switch to it by name, like "Chrome", "Notepad", "File Explorer" or "Spotify". Returns the screen afterwards.',
    { name: { type: 'string' } }, ['name']),
  tool('list_windows',
    'List the open windows, and the tabs in browsers and other tabbed apps (Chrome, Edge, File Explorer, Terminal). Use before switching when you are not sure of the name.'),
  tool('switch_to',
    'Bring a window or tab to the front by (part of) its name, like "YouTube", "Gmail", "WhatsApp", "Excel" or "Downloads". Finds browser tabs across open windows. Returns the screen afterwards.',
    { name: { type: 'string', description: 'Part of the tab title, window title or app name.' },
      kind: { type: 'string', enum: ['any', 'tab', 'window'], description: 'Only tabs, only windows, or either (default).' } },
    ['name']),
  tool('open_url',
    'Open a website in the default browser, like "excalidraw.com" or a full link. Returns the screen afterwards.',
    { url: { type: 'string' } }, ['url']),
];

const gridPX = { type: 'number', description: '0 = left edge, 1000 = right edge of the PHONE screen' };
const gridPY = { type: 'number', description: '0 = top edge, 1000 = bottom edge of the PHONE screen' };

/** Using the user's Android phone (through Bluey's phone app). */
const phoneTools = [
  tool('phone_look',
    "Look at the user's PHONE screen: the front app, every piece of text and control (N ids, positions on a 0-1000 grid of the phone screen), and a screenshot. Call before tapping or typing on the phone."),
  tool('phone_tap',
    'Tap something on the phone. Prefer an N id from phone_look; use x and y (0-1000 phone grid) otherwise. Returns the phone screen afterwards.',
    { target_id: { type: 'string', description: 'An N id from phone_look.' }, x: gridPX, y: gridPY,
      long: { type: 'boolean', description: 'Long-press instead of a tap.' } }),
  tool('phone_type',
    'Type text into a text field on the phone (the focused one, or the N id given). Returns the phone screen afterwards.',
    { text: { type: 'string' }, target_id: { type: 'string', description: 'An N id of a text field (optional).' },
      press_enter: { type: 'boolean', description: 'Press the keyboard action key afterwards (send/search).' },
      replace: { type: 'boolean', description: 'Replace what is in the field (default true).' } },
    ['text']),
  tool('phone_scroll', 'Scroll the phone screen. Returns the phone screen afterwards.',
    { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, ['direction']),
  tool('phone_key', 'Press a phone system button: back, home, recents, notifications or quick_settings. Returns the phone screen afterwards.',
    { key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quick_settings'] } }, ['key']),
  tool('phone_open_app', 'Open an app on the phone by name, like "WhatsApp", "Instagram", "YouTube", "Camera", "Settings". Returns the phone screen afterwards.',
    { name: { type: 'string' } }, ['name']),
  tool('phone_open_url', 'Open a link on the phone (web, tel:, geo:, mailto:, whatsapp:). Returns the phone screen afterwards.',
    { url: { type: 'string' } }, ['url']),
  tool('phone_apps', 'List the apps installed on the phone.'),
  tool('phone_bluey', "Bring Bluey's face back to the front of the phone when you're done using it."),
];

const actionNames = new Set(actionTools.map((t) => t.name));
const phoneNames = new Set(phoneTools.map((t) => t.name));

function list(computerControl, phoneControl) {
  return [...lookTools, ...(computerControl ? actionTools : []), ...(phoneControl ? phoneTools : [])];
}

module.exports = { list, actionNames, phoneNames, lookTools, actionTools, phoneTools };
