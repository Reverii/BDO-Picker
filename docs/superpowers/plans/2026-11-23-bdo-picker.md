# BDO Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Telegram Mini App where the BDO planner sets BDO dates and crew pick them first come, first served, with a queue behind the first picker.

**Architecture:** A static page (GitHub Pages) runs inside Telegram as a Mini App and sends every request, with Telegram's signed `initData`, to a Google Apps Script web app. The script verifies the signature, applies the rules under a lock and reads/writes a Google Sheet. The rules and the signature check are plain JS files with no Apps Script calls, so Node tests run them directly; `Code.gs` is tested in Node against small fakes of `SpreadsheetApp`, `LockService` and `UrlFetchApp`.

**Tech Stack:** HTML/CSS/vanilla JS (no build step), `telegram-web-app.js` from telegram.org, Google Apps Script (V8), Node 22 `node:test`, Playwright (pre-installed) for the page test.

**Spec:** `docs/superpowers/specs/2026-11-23-bdo-picker-design.md`. Visual reference: the mock-up https://claude.ai/artifact/442LA6GBgs41Yomeb99mJu (colours, layout, wording of buttons and hints).

## Global Constraints

- Stored data: callsign, Telegram ID, Telegram username, dates. No full names anywhere. Repo holds no crew data (it is public).
- The bot token lives only in Apps Script Script Properties (`BOT_TOKEN`), never in the page or the repo.
- Callsigns are compared upper-case and trimmed.
- Dates are `YYYY-MM-DD` strings; "today" is Singapore time (`Asia/Singapore`).
- First picker = BDO; later pickers join the queue in pick order. No limit on days per person. No "full" state.
- BDO drops: queue[0] becomes BDO, rest move up; empty queue: day open. Leaving the queue: people behind move up.
- Only dates the planner set can be picked. No open-day alerts to the planner.
- Admins can add an admin from linked callsigns and can remove only themselves; the last admin cannot.
- Bot messages (exact copy):
  - promoted: `You're now BDO on {Weekday D Mon}. {OLD} dropped the day, so you moved up from first in the queue.`
  - day removed: `{Weekday D Mon} is no longer needed as a BDO day, so it has been taken off your days.`
  - new admin: `You're now a BDO planner. Open BDO Picker to set the BDO days.`
- Plain English in all UI text. Touch targets at least 44 px. Works at 360 px width.

## Review Focus

1. Two people pick the same open date at the same moment: exactly one is BDO, the other is queue 1 (lock in `Code.gs`, re-read inside the lock).
2. Double tap / repeat pick by someone already BDO or queued on that date: rejected, no duplicate entry.
3. Missing, forged or older-than-24-hours `initData`: rejected with no Sheet change.
4. Page opened in a normal browser (no Telegram `initData`): shows "Open BDO Picker from the Telegram link." and makes no requests.
5. Dates before today (SGT): pick, drop and set/unset are rejected.

Tests pinning each line are named in Tasks 1 to 4.

---

## File map

| File | Responsibility |
|---|---|
| `apps-script/Rules.gs` | pure rules: pick, drop, set/unset day, link callsign, add/remove admin |
| `apps-script/Auth.gs` | `verifyInitData` (Telegram signature + age) |
| `apps-script/Code.gs` | `doPost` router, Sheet I/O, lock, Telegram sends, `setup()` |
| `index.html`, `app.css`, `app.js`, `config.js` | the Mini App page |
| `tests/load_gs.js` | loads `.gs` files into a Node `vm` context |
| `tests/gas_fakes.js` | in-memory fakes of the Apps Script services |
| `tests/fake_api.js` | browser-side fake of the API for the page test |
| `tests/*.test.js` | tests; `npm test` runs all |
| `README.md` | setup guide for the owner (bot, Sheet, script, Pages) |

## Data shapes

- Day: `{ date: 'YYYY-MM-DD', bdo: 'HAWK' | '', queue: ['VIPER', 'OSPREY'] }`
- Sheet tabs (row 1 = headers):
  - `Days`: A Date (text), B BDO, C Queue (comma-separated, in order)
  - `Crew`: A Callsign, B Telegram ID (text), C Telegram username
  - `Admins`: A Callsign
  - `Log`: A When (ISO), B Who (callsign), C What
- Rules errors: `throw new RuleError(code, message)`; `message` is shown to the user as-is.

---

### Task 1: Rules

**Files:**
- Create: `package.json` (`"test": "node --test tests/"`, no dependencies), `apps-script/Rules.gs`, `tests/load_gs.js`
- Test: `tests/rules.test.js`

**Interfaces:**
- Produces (globals in `Rules.gs`):
  - `class RuleError extends Error { constructor(code, message) }` with `.code`
  - `normCall(s) -> string`
  - `pickDay(day, me, today) -> { day, result: 'bdo' | 'queued', position: number }` (position 0 for bdo, 1-based in queue)
  - `dropDay(day, me, today) -> { day, promoted: string | '', result: 'dropped' | 'left' }`
  - `setDay(days, date, on, today) -> { days, removed: Day | null }` (`days` is an array sorted by date)
  - `linkCallsign(crew, telegramId, username, callsign) -> crew` (crew rows `{ callsign, telegramId, username }`)
  - `addAdmin(admins, crew, callsign) -> admins`; `removeSelf(admins, me) -> admins`
  - `fmtDay(date) -> 'Saturday 5 Dec'`
- `tests/load_gs.js`: `loadGs(files: string[], extraGlobals = {}) -> context` (runs each file in one `vm` context and returns it)

- [ ] **Step 1: Write the failing tests** in `tests/rules.test.js` (`node:test`, `assert/strict`), `today = '2026-12-01'`:
  - `pick open day makes you BDO`: `pickDay({date:'2026-12-05',bdo:'',queue:[]}, 'mamba', today)` returns result `'bdo'`, `day.bdo === 'MAMBA'`, position 0.
  - `second and third pickers queue in order`: picks by HAWK, VIPER, OSPREY give `bdo 'HAWK'`, `queue ['VIPER','OSPREY']`, positions 1 and 2. (Review Focus 1, rules side)
  - `repeat pick is rejected`: HAWK picks twice: code `ALREADY_ON`; VIPER queued then picks again: `ALREADY_ON`, queue length still 1. (Review Focus 2)
  - `BDO drop promotes queue head`: `{bdo:'HAWK',queue:['VIPER','OSPREY']}` drop by HAWK gives `bdo 'VIPER'`, `queue ['OSPREY']`, `promoted 'VIPER'`.
  - `BDO drop with empty queue opens the day`: `bdo ''`, `promoted ''`.
  - `leaving the queue moves people up`: `{bdo:'HAWK',queue:['VIPER','MAMBA','OSPREY']}` drop by MAMBA gives queue `['VIPER','OSPREY']`, result `'left'`.
  - `drop by someone not on the day`: code `NOT_ON`.
  - `past dates are rejected`: pick, drop and `setDay` on `'2026-11-30'` with today `'2026-12-01'` throw code `PAST`. (Review Focus 5)
  - `setDay adds sorted and removes returning the old day`: add `'2026-12-12'` then `'2026-12-05'`: dates sorted; remove `'2026-12-05'` that had `bdo 'HAWK'` returns it as `removed`; adding an existing date or removing a missing one is a no-op with `removed null`.
  - `link callsign`: links when free; code `TAKEN` if another Telegram ID holds it; code `UNKNOWN` if the callsign is not in crew; relinking the same Telegram ID to a second callsign: code `ALREADY_LINKED`.
  - `admins`: `addAdmin` rejects a callsign not linked in crew (`NOT_LINKED`) and an existing admin (`ALREADY_ADMIN`); `removeSelf(['MAMBA'],'MAMBA')` code `LAST_ADMIN`; `removeSelf(['MAMBA','OSPREY'],'MAMBA')` returns `['OSPREY']`.
  - `fmtDay('2026-12-05') === 'Saturday 5 Dec'`.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`Rules.gs` missing).
- [ ] **Step 3: Implement** `tests/load_gs.js` and `apps-script/Rules.gs`. Functions return new objects (no mutation of inputs). Date comparison is string comparison on `YYYY-MM-DD`. Error messages are short plain sentences, e.g. `ALREADY_ON`: "You're already on this day."
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: BDO rules (pick, queue, drop, days, admins)`.

### Task 2: Telegram signature check

**Files:**
- Create: `apps-script/Auth.gs`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `RuleError` from Task 1.
- Produces: `verifyInitData(initData: string, botToken: string, hmac: (key: string|number[], msg: string) => number[], nowSec: number, maxAgeSec = 86400) -> { id: string, username: string }`. `hmac` returns bytes 0..255. Throws `RuleError('AUTH', 'Open BDO Picker from the Telegram link.')`.
- Algorithm (Telegram Web Apps): parse `initData` as URL query; remove `hash`; `dataCheckString` = remaining `key=value` pairs (decoded values) sorted by key, joined with `\n`; `secret = hmac('WebAppData', botToken)`; valid when hex(`hmac(secret, dataCheckString)`) equals `hash`, and `nowSec - auth_date <= maxAgeSec`. User comes from the `user` JSON field; `id` as a string.

- [ ] **Step 1: Write the failing tests.** A helper in the test signs a payload with Node `crypto` the way Telegram does (`user={"id":5123,"username":"mamba_ops"}`, `auth_date`, `query_id`):
  - `valid initData returns the user` (`id '5123'`, `username 'mamba_ops'`)
  - `tampered user is rejected`, `wrong bot token is rejected`, `missing hash is rejected`, `empty string is rejected`
  - `initData older than 24 hours is rejected` (Review Focus 3)
- [ ] **Step 2: Run** `npm test`. Expected: the auth tests FAIL.
- [ ] **Step 3: Implement** `Auth.gs`. Avoid `URLSearchParams` (not in Apps Script): split on `&` and `=`, `decodeURIComponent` values. Compare hashes in constant time over the hex strings.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: verify Telegram initData`.

### Task 3: Apps Script web app

**Files:**
- Create: `apps-script/Code.gs`, `apps-script/appsscript.json` (`timeZone: "Asia/Singapore"`, `runtimeVersion: "V8"`, web app `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`), `tests/gas_fakes.js`
- Test: `tests/server.test.js`

**Interfaces:**
- Consumes: everything in Tasks 1 and 2.
- Produces:
  - `doPost(e)`: body `e.postData.contents` is JSON `{ initData, action, ...args }`. Returns `ContentService` JSON text: `{ ok: true, ...data }` or `{ ok: false, error: string }`.
  - Actions and data:
    - `whoami` -> `{ linked, callsign, isAdmin, crew: [{ callsign, taken }] }` (crew only when not linked)
    - `month` `{ month: 'YYYY-MM' }` -> `{ days: Day[] }` for that month
    - `link` `{ callsign }` -> `whoami` data
    - `pick` / `drop` `{ date }` -> `{ day, message }` (message is the hint shown in the mock-up, e.g. "HAWK got there first. You are number 2 in the queue for Saturday 5 Dec.")
    - admin only (else `error 'Only the BDO planner can do that.'`): `setDay` `{ date, on }` -> `{ days }` for that month; `admins` -> `{ admins, lastChange }`; `addAdmin` `{ callsign }`, `removeMe` -> `{ admins, lastChange }`
  - `setup()`: creates the four tabs with headers if missing (run once by the owner from the editor).
  - Every successful write appends a `Log` row; `lastChange` is the newest Log row about admins, as `"{who} added {X} · {d Mon}"`.
  - Bot sends via `UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id, text }), muteHttpExceptions: true })`; a failed send is logged as `"message to X not delivered"` and never fails the action.
- `tests/gas_fakes.js`: `makeGas({ botToken, now }) -> { globals, sheet(name) -> string[][], sent: {chat_id,text}[], lockCalls: number }` providing `SpreadsheetApp.getActive().getSheetByName/insertSheet` with `getDataRange().getValues()`, `getRange(r,c,nr,nc).setValues()`, `appendRow`, `deleteRow`, `clearContents`; `LockService.getScriptLock().waitLock/releaseLock`; `PropertiesService.getScriptProperties().getProperty`; `ContentService.createTextOutput().setMimeType()`; `UrlFetchApp.fetch`; `Utilities.computeHmacSha256Signature`, `Utilities.formatDate` (enough for `yyyy-MM-dd` in Asia/Singapore).

- [ ] **Step 1: Write the failing tests** (each starts from a Sheet with crew HAWK, VIPER, MAMBA, OSPREY linked to IDs 1..4, admin MAMBA, Days `2026-12-05` open; `now` = 2026-12-01 SGT; requests signed with the Task 2 helper):
  - `pick then pick: BDO then queue`: HAWK picks, VIPER picks: Days row = `2026-12-05 | HAWK | VIPER`; `lockCalls` is 2. (Review Focus 1)
  - `drop promotes and messages the new BDO`: then HAWK drops: row `VIPER | ''`; `sent` has chat_id 2 with the exact promoted copy from Global Constraints.
  - `bad initData changes nothing`: a forged request returns `ok:false`, Sheet unchanged. (Review Focus 3)
  - `non-admin cannot setDay`; `admin setDay off messages everyone on it` (day-removed copy to the BDO and each queued person).
  - `failed Telegram send still succeeds`: fake `fetch` returns code 403; action `ok:true`, Log has the not-delivered row.
  - `whoami for an unlinked user lists crew with taken flags`; `link` then `whoami` shows linked.
  - `addAdmin sends the new-admin message`; `removeMe as last admin is refused`.
- [ ] **Step 2: Run** `npm test`. Expected: the server tests FAIL.
- [ ] **Step 3: Implement** `Code.gs` and `appsscript.json`. All writes: `waitLock(10000)`, re-read the tab, apply the rule, write back, release in `finally`. Telegram ID column stored as text (`'` prefix not needed if the cell format is set to plain text in `setup()`).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Apps Script web app over the Sheet`.

### Task 4: The Mini App page

**Files:**
- Create: `index.html`, `app.css`, `app.js`, `config.js` (`window.BDO_CONFIG = { apiUrl: 'PASTE_YOUR_APPS_SCRIPT_URL_HERE' }`), `tests/fake_api.js`
- Test: `tests/page.test.js`

**Interfaces:**
- Consumes: the API in Task 3 (exact action names and data).
- Produces: `app.js` calls `api(action, args) -> Promise<data>`: `fetch(BDO_CONFIG.apiUrl, { method: 'POST', body: JSON.stringify({ initData, action, ...args }) })` with no custom headers (keeps it a CORS "simple request" Apps Script accepts). When `window.BDO_FAKE_API` exists, `api` calls it instead (test hook). `initData` comes from `Telegram.WebApp.initData`; when empty, the page shows the outside-Telegram message and stops.
- `tests/fake_api.js`: `window.BDO_FAKE_API = (action, args) => Promise` over in-memory state, using `Rules.gs` loaded in the page by the test (`page.addScriptTag`).

Screens follow the mock-up (Telegram light colours, `#1c6db5` accent; use `Telegram.WebApp.themeParams` for background/text when present so dark mode works):
- **First time:** callsign radio list (linked ones disabled, "already linked"), button "I'm {CALLSIGN}". Call `Telegram.WebApp.requestWriteAccess()` before `link` so the bot may message them.
- **Pick a day:** month title with previous/next arrows (start at the current SGT month), legend, calendar (Mon first), day panel with BDO and numbered queue, the hint line, status line after an action, "My days" chips, bottom button with the four labels from the spec. Use `Telegram.WebApp.ready()` and `expand()`.
- **Planner tab** (shown only when `isAdmin`): tabs "Pick days" / "Planner"; tap a date to set/unset (confirm before removing a day someone holds: "Remove Sat 5 Dec? HAWK, VIPER will be told."), the three counts, "Who has what", Admins section with add dropdown, "Remove me" on your own row only (disabled with the explanation when you are the last admin), and the last-change line. No "Post open days" button.

- [ ] **Step 1: Write the failing tests** with Playwright (`require('playwright')`, `chromium.launch()`), serving the repo folder with a tiny `http.createServer` static server, a stub `window.Telegram.WebApp` injected via `addInitScript` (`initData: 'test'`, `ready`, `expand`, `requestWriteAccess(cb) { cb(true) }`, `themeParams: {}`), and `tests/fake_api.js`; fake today 2026-12-01 via `window.BDO_TODAY`:
  - `outside Telegram shows the link message and makes no requests` (stub with `initData: ''`; fake API call count 0). (Review Focus 4)
  - `first time: link callsign then calendar appears` (VIPER greyed out as linked; pick MAMBA; button reads "I'm MAMBA"; then "December 2026" visible).
  - `pick an open day then a taken day`: tap 12 -> "Take this day" -> chip "Sat 12 Dec · BDO"; tap 5 (HAWK) -> "Join the queue" -> status contains "number 2 in the queue" when VIPER is already queued.
  - `double tap sends one pick` : two quick clicks on the action button produce one `pick` call (button disabled while a request is in flight). (Review Focus 2, page side)
  - `planner tab only for admins`, and `set a day as planner`: tap 19 in Planner, then in Pick days the 19th shows "OPEN".
  - `fits at 360 px`: `document.documentElement.scrollWidth <= 360`.
- [ ] **Step 2: Run** `npm test`. Expected: page tests FAIL.
- [ ] **Step 3: Implement** the page files. No libraries besides `https://telegram.org/js/telegram-web-app.js`. `BDO_TODAY` overrides today for tests only.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Take one 390x844 screenshot of each screen at deviceScaleFactor 1 and compare against the mock-up by eye.
- [ ] **Step 5: Commit** `feat: Mini App page`.

### Task 5: Setup guide and push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write `README.md`** for the owner, plain English, numbered steps:
  1. Make the bot (@BotFather `/newbot`), keep the token private.
  2. Make the Google Sheet; Extensions > Apps Script; paste `Rules.gs`, `Auth.gs`, `Code.gs` and `appsscript.json` (show the manifest via Project Settings); Project Settings > Script Properties: `BOT_TOKEN`; run `setup` once; fill `Crew` (callsigns only) and `Admins` (your callsign); Deploy > New deployment > Web app, Execute as Me, Who has access Anyone; copy the URL.
  3. Put the URL in `config.js`, commit; Settings > Pages > Deploy from branch `main`, folder `/`.
  4. @BotFather `/newapp`, Web App URL = the Pages address, short name `pick`; post `t.me/<bot>/pick` in the group.
  5. Updating the script later: Deploy > Manage deployments > edit > New version (the URL stays the same).
  Plus a short "how it works" (queue rules) and "fixing things by hand in the Sheet" (clear a Telegram ID to unlink; edit Admins).
- [ ] **Step 2: Run** `npm test`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: setup guide` and push the branch `claude/build-bdo-picker`.
