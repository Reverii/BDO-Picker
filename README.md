# BDO Picker

A Telegram Mini App for picking BDO dates. The BDO planner sets the dates that need a BDO. Each person
opens BDO Picker from Telegram and picks the dates they want. The first person to pick a date is the BDO.
Everyone who picks it after that joins that date's queue, in the order they picked.

## How it works

- **Picking:** tap a blue-outlined date and press **Take this day** to become BDO. On a date someone
  already has, press **Join the queue**. There is no limit on how many dates you pick.
- **Dropping out:** if the BDO drops a date, number 1 in the queue becomes BDO, everyone else moves up
  one place, and the new BDO gets a Telegram message. If nobody is in the queue, the date shows as open
  again. Leaving the queue moves everyone behind you up one place.
- **Planner (admins only):** a **Planner** tab where you tap dates to turn them into BDO days or back.
  Removing a date that people have picked asks first, and they get a Telegram message.
- **Admins:** any admin can make another linked person an admin. Admins can remove only themselves, and
  the last admin can't. Every change is written to the **Log** tab.
- **Past dates** can't be picked, dropped or changed.

Where things live:

| Part | Where |
|---|---|
| The page people see | GitHub Pages (this repo: `index.html`, `app.js`, `app.css`, `config.js`) |
| The data | your Google Sheet (tabs Days, Crew, Admins, Log) |
| The go-between | a Google Apps Script attached to the Sheet (`apps-script/`) |
| Who's who | Telegram: the bot link tells the script which Telegram account tapped it |

The repo is public and holds no names or dates. Callsigns and Telegram IDs stay in your Sheet.

## Setting it up (about 30 minutes, once)

### 1. Make the Telegram bot

1. In Telegram, open **@BotFather** (blue tick) and send `/newbot`.
2. Give it a name (e.g. `BDO Picker`) and a username ending in `bot` (e.g. `sqn121_bdo_bot`).
3. BotFather sends you a **token** like `123456:ABC-...`. Treat it like a password: don't post it in any
   chat or put it on GitHub. You'll paste it into the Google script in step 2.

### 2. Make the Google Sheet and the script

1. Go to [sheets.new](https://sheets.new) and name the sheet, e.g. `BDO Picker`.
2. In the Sheet: **Extensions > Apps Script**. A script editor opens.
3. In the editor, click **Project Settings** (the gear) and tick **Show "appsscript.json" manifest file
   in editor**. Back in **Editor** (`< >`):
   - Open `appsscript.json` and replace everything in it with this repo's
     [`apps-script/appsscript.json`](apps-script/appsscript.json).
   - Rename `Code.gs` if needed and replace its contents with [`apps-script/Code.gs`](apps-script/Code.gs).
   - Click **+ > Script**, name it `Rules`, and paste [`apps-script/Rules.gs`](apps-script/Rules.gs).
   - Click **+ > Script**, name it `Auth`, and paste [`apps-script/Auth.gs`](apps-script/Auth.gs).
   - Press **Save** (the disk icon).
4. **Project Settings > Script Properties > Add script property**: Property `BOT_TOKEN`, Value = the
   token from step 1. Save.
5. Back in the editor, open `Code.gs`, choose **setup** in the function list at the top and press **Run**.
   Google asks for permission the first time: choose your account, then **Advanced > Go to BDO Picker
   (unsafe)** (it says "unsafe" only because you wrote the script yourself), then **Allow**. The Sheet
   now has four tabs: **Days, Crew, Admins, Log**.
6. Fill in the Sheet:
   - **Crew** tab, column A: every callsign that can pick BDO dates, one per row. Leave columns B and C
     empty; they fill in when people link their Telegram account.
   - **Admins** tab, column A: your own callsign.
7. **Deploy > New deployment**. Click the gear next to "Select type" and choose **Web app**. Set
   **Execute as: Me** and **Who has access: Anyone**. Press **Deploy** and copy the **Web app URL**
   (it ends in `/exec`).
8. Check it: open that URL in a browser. It should say `BDO Picker is running.`

### 3. Put the page on GitHub Pages

1. On GitHub, open this repo's `config.js`, press the pencil (edit), replace
   `PASTE_YOUR_APPS_SCRIPT_URL_HERE` with the URL from step 2.7 (keep the quotes), and commit to `main`.
2. **Settings > Pages**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**, **Save**.
3. After a minute or two the page is at `https://reverii.github.io/BDO-Picker/`. Opened in a normal
   browser it only says "Open BDO Picker from the Telegram link." That's expected: it needs Telegram to
   say who you are.

### 4. Connect the page to the bot

1. In @BotFather send `/newapp` and choose your bot.
2. Give it a title, a short description and a 640×360 picture (any simple banner). Skip the GIF with
   `/empty`.
3. For the **Web App URL**, paste `https://reverii.github.io/BDO-Picker/`.
4. Give it a short name, e.g. `pick`. BotFather replies with the link, e.g. `t.me/sqn121_bdo_bot/pick`.
5. Optional: `/setmenubutton`, choose the bot, paste the same URL and call the button `Open BDO Picker`,
   so the button also shows in the bot's own chat.

### 5. Try it, then share it

1. Open the `t.me/.../pick` link yourself. Pick your callsign, then allow the bot to message you when
   Telegram asks (otherwise you won't get "you're now BDO" messages).
2. Open the **Planner** tab and tap a few dates.
3. Post the link in the squadron group.

## Looking after it

- **Changing the crew list:** add or remove rows in the **Crew** tab.
- **Someone linked the wrong callsign:** in **Crew**, clear their Telegram ID and username (columns B
  and C). They pick again the next time they open BDO Picker.
- **Admins:** use the Planner tab, or edit the **Admins** tab directly if you ever get locked out.
- **Fixing a date by hand:** the **Days** tab has one row per BDO date: Date (`YYYY-MM-DD`), BDO and Queue
  (callsigns separated by commas, in order).
- **Someone didn't get a bot message:** the Log shows `message to X not delivered`. They need to open the
  bot's chat once and press **Start**.
- **Updating the script after a change in this repo:** paste the new files into the script editor, then
  **Deploy > Manage deployments > pencil > Version: New version > Deploy**. The URL stays the same, so
  `config.js` doesn't change.

## For developers

No build step. Tests need Node 22 and Playwright with Chromium:

```bash
npm test
```

- `apps-script/Rules.gs`: the rules (pick, queue, drop, days, admins), plain JavaScript.
- `apps-script/Auth.gs`: checks Telegram's signature on each request.
- `apps-script/Code.gs`: the web app: request handling, Sheet reads and writes, bot messages.
- `tests/`: rules, signature, script (against stand-ins for Google's services) and the page (Playwright,
  against an in-browser stand-in for the script).
- Design and plan: `docs/superpowers/`.
