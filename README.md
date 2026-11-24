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
| The server | a Cloudflare Worker (`worker/`) |
| The data | a Cloudflare D1 database (tables days, crew, admins, log, settings) |
| Who's who | Telegram: the bot link tells the server which Telegram account tapped it |

The repo is public and holds no names or dates. Callsigns and Telegram IDs stay in your D1 database.

## Setting it up (about 30 minutes, once)

You need a free Cloudflare account and Node.js 20 or newer on your computer.

### 1. Make the Telegram bot

1. In Telegram, open **@BotFather** (blue tick) and send `/newbot`.
2. Give it a name (e.g. `BDO Picker`) and a username ending in `bot` (e.g. `sqn121_bdo_bot`).
3. BotFather sends you a **token** like `123456:ABC-...`. Treat it like a password: don't post it in any
   chat or put it on GitHub. You'll give it to Cloudflare in step 2.

### 2. Put the server on Cloudflare

In a terminal, in this repo's `worker` folder:

1. Install the tools and sign in to Cloudflare (a browser window opens):

   ```bash
   npm install
   ```

   ```bash
   npx wrangler login
   ```

2. Make the database. `apac` keeps it near Singapore:

   ```bash
   npx wrangler d1 create bdo-picker --location=apac
   ```

   It prints a `database_id`. Open `worker/wrangler.toml` and paste it in place of
   `PASTE_DATABASE_ID_HERE` (keep the quotes).
3. Give the server the bot token. It asks you to paste it; it is stored encrypted on Cloudflare, not in
   the repo:

   ```bash
   npx wrangler secret put BOT_TOKEN
   ```

4. Make the tables and put the server live:

   ```bash
   npm run deploy
   ```

   It prints the server's address, like `https://bdo-picker.<your-name>.workers.dev`. Open it in a
   browser: it should say `BDO Picker is running.`
5. Add the crew and yourself as the first admin. Either in the Cloudflare dashboard (**Storage &
   Databases > D1 > bdo-picker > Console**) or from the terminal. Change the callsigns to yours:

   ```bash
   npx wrangler d1 execute bdo-picker --remote --command "INSERT INTO crew (callsign) VALUES ('HAWK'), ('VIPER'), ('MAMBA'); INSERT INTO admins (callsign) VALUES ('MAMBA');"
   ```

   After this you can add and remove crew from the **Planner** tab in the app.

**Coming from the Google Sheet version?** Instead of step 5, bring your data across: in the Sheet,
for each of the tabs Days, Crew, Admins and Log, choose **File > Download > Comma-separated values**
and put the four files in one folder. Then, in `worker`:

```bash
node scripts/import-sheet.mjs ~/Downloads/bdo-csv > import.sql
```

```bash
npx wrangler d1 execute bdo-picker --remote --file=import.sql
```

Do this once, before anyone uses the new address. The group connection isn't in the Sheet, so tap
**Find group** on the Planner tab again afterwards (step 6).

### 3. Put the page on GitHub Pages

1. On GitHub, open this repo's `config.js`, press the pencil (edit), put the server address from
   step 2.4 in `apiUrl` (keep the quotes), and commit to `main`.
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

### 6. Let the bot post in the group (optional)

1. Add the bot to the squadron group (group info > Add members > search the bot's username).
2. Send `/bdo` in the group.
3. In BDO Picker, open **Planner** and tap **Find group**. It should say "Connected to" your group's name.
4. From then on, **Preview message** and **Post to group** on the Planner tab post the month on screen.

The **Open BDO Picker** button in the post points to `t.me/<your bot>/pick`. If you gave the Mini App a short name
other than `pick` in step 4, change `APP_NAME` in `worker/wrangler.toml` to that short name and run
`npm run deploy` again.

## Looking after it

The data is in the D1 database. To look at it or fix something by hand, use the Cloudflare dashboard
(**Storage & Databases > D1 > bdo-picker**: **Tables** to browse, **Console** to run SQL) or
`npx wrangler d1 execute bdo-picker --remote --command "..."` from `worker`.

- **Changing the crew list:** use the **Crew** section on the Planner tab.
- **Someone linked the wrong callsign:** clear their Telegram ID and username. They pick again the next
  time they open BDO Picker:
  `UPDATE crew SET telegram_id = '', username = '' WHERE callsign = 'HAWK';`
- **Admins:** use the Planner tab. If you're ever locked out:
  `INSERT INTO admins (callsign) VALUES ('MAMBA');`
- **Fixing a date by hand:** the Planner tab can put people on a day or take them off. The **days**
  table has one row per BDO date: `date` (`YYYY-MM-DD`), `bdo`, and `queue` (callsigns separated by
  commas, in order).
- **Seeing what happened:** `SELECT * FROM log ORDER BY id DESC LIMIT 50;`
- **Someone didn't get a bot message:** the log shows `message to X not delivered`. They need to open the
  bot's chat once and press **Start**.
- **Updating the server after a change in this repo:** in `worker`, run `npm run deploy`. It applies any
  new database changes first. The address stays the same, so `config.js` doesn't change.
- **Server errors:** Cloudflare dashboard > **Workers & Pages > bdo-picker > Logs**.

## For developers

The page has no build step. Tests need Node 22 and Playwright with Chromium:

```bash
npm test
```

- `worker/src/rules.js`: the rules (pick, queue, drop, days, admins), plain JavaScript. The page tests
  load it too.
- `worker/src/auth.mjs`: checks Telegram's signature on each request.
- `worker/src/picker.mjs`: request handling, database reads and writes, bot messages.
- `worker/src/index.mjs`: the Worker. It sends every request to one Durable Object, so changes happen
  one at a time (two people taking the same day can't both become BDO).
- `worker/migrations/`: the database tables.
- `tests/`: rules, signature, server (against D1 stand-in on Node's built-in SQLite) and the page
  (Playwright, against an in-browser stand-in for the server).
- Try the server locally: in `worker`, put `BOT_TOKEN="..."` in `.dev.vars`, then
  `npx wrangler d1 migrations apply bdo-picker --local` and `npm run dev`.
- Design and plan: `docs/superpowers/` (written for the earlier Google Sheet version).
