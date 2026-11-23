# BDO Dashboard: handoff brief

Status: design agreed through a clickable mock-up, not yet built. Nothing below has been implemented.

Mock-up: https://claude.ai/artifact/442LA6GBgs41Yomeb99mJu (4 phone screens: pick a day, planner with
Admins section, first-time callsign link, bot message).

## Why

121 SQN picks BDO (duty officer) dates through Telegram today. There is a lot of back-and-forth just to
settle who takes which date. The goal is one page where the dates are posted once, people pick, and
everyone can see who has each day. No more "is the 12th taken?" messages.

It is a standalone tool. It is NOT connected to LODESTAR or SharePoint for now (it may be later, so keep
the data simple to export).

## What it does (owner's requirements)

1. **BDO planner (admin)** sets which dates need a BDO.
2. **Each BDO** opens the page and picks from those dates. A date can be picked only once the planner
   has set it. There is no limit on how many dates one person picks.
3. **Overlap = first come, first served, with a queue.** The first person to pick a date is the BDO.
   Everyone who picks it after that joins that date's **queue** in the order they picked (1, 2, 3...).
   There is no single "backup" and no "full" state.
4. **Drop-outs:** if the BDO drops the date, number 1 in the queue becomes BDO and everyone behind moves
   up one place. If someone in the queue leaves it, everyone behind them moves up one place. If the BDO
   drops and the queue is empty, the date shows as open again.
5. **Admin rights can be passed on:** any admin can add another admin from the linked callsigns, and can
   remove **only themselves** (no removing other admins). The last admin cannot remove themselves. Every
   admin change is logged. The Sheet owner can always fix the admin list directly in the Sheet.
6. **No "open day" alerts to the planner** (owner said no).

## How it is built (decided)

- **Hosted outside the squadron intranet**, opened from a link posted in Telegram, mostly on phones.
- **Identity = Telegram user ID.** The page runs as a **Telegram Mini App** opened through a bot link
  (e.g. `t.me/<BotName>/<app>`). Telegram passes signed `initData` with the user's numeric ID. The
  server must verify the signature with the bot token (HMAC-SHA256, the "WebAppData" key scheme) before
  trusting the ID. A plain github.io link opened in a browser gets no ID, so post the bot link.
- **Page:** static HTML/JS on **GitHub Pages**, in a **new repo, separate from LODESTAR**. The repo holds
  only code, no names or dates.
- **Storage:** a **Google Sheet** owned by the owner's Google account, behind a **Google Apps Script web
  app** that the page calls. The script verifies Telegram `initData` (the bot token is kept in Script
  Properties, never in the page) and does the reads and writes.
- **Privacy:** store callsign or initials, Telegram ID and dates only. No full names.

## Screens and messages (as in the mock-up)

- **First open:** the user picks their callsign from the planner's crew list, which links their Telegram
  ID to it. Callsigns already linked are greyed out. An admin can fix a wrong link.
- **Pick a day:** a month calendar. Dates not set by the planner are greyed out and can't be tapped.
  Open dates have a blue outline; taken dates are amber and show the BDO; your dates are solid blue
  ("BDO" or "QUEUE n"). Tapping a date shows the BDO and the numbered queue. The main button is
  Take this day / Join the queue / Drop this day / Leave the queue. "My days" lists what you hold.
- **Planner (admins only):** a Planner tab. Tap a date to set it or remove it. Counts at the top show
  BDO days, days with a BDO and days still open, with a "Who has what" list underneath. An
  "Admins" section lets admins add an admin or remove themselves. A "Post open days to the group"
  button is in the mock-up (my idea, not requested; keep or drop).
- **Bot messages:** the person who moves up to BDO gets a Telegram message. People on a date the planner
  removes get a message that the date is no longer needed. A new admin gets "You're now a BDO planner".

## Builder notes

- **Race safety:** two people tapping the same date at once must not both become BDO. Do every claim,
  drop and queue change in Apps Script under `LockService`, re-reading the row inside the lock. The
  later claimant goes into the queue.
- Sheet tabs (suggested): Days (date, BDO, queue as an ordered list), Crew (callsign, Telegram ID),
  Admins, Log (every change: who, what, when).

## Setup steps the owner will do

1. Create a bot with @BotFather and register the Mini App (BotFather `/newapp`) pointing at the GitHub
   Pages URL.
2. Create the Google Sheet and Apps Script project, add the bot token to Script Properties, and deploy as
   a web app ("Execute as me, access: anyone").
3. Post the Mini App link in the Telegram group.
