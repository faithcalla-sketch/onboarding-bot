# Onboarding Bot

Tells a client their setup is ready to go live — on Discord, or by text when they
never joined Discord — without anyone retyping the date and the sheet link.

Today that job is: the team finishes a setup in Trello, someone opens the card,
finds the client's channel, writes the message, pastes the sheet, asks them to
confirm the launch date, and later remembers to check whether they ever answered.
This bot does all of that from the card, and asks you to press one button before
anything reaches the client.

## The flow

```
Team finishes the setup on Trello
        │
        │  you run:  /notify card:<trello link>
        ▼
Bot reads the card: client, campaign, go-live date, sheet link,
Discord channel, agent, phone
        │
        ▼
Draft appears in your internal review channel
   ⛔ missing sheet or date?  it says which Trello field to fix
   ⚠️  past date, weekend, odd link?  it says so, but lets you send
        │
        │  you press "Approve & send on Discord"
        ▼
Message posts in the client's setup channel, @mentioning the agent
        │
        ├── client replies  ──►  marked confirmed, team notified, chasing stops
        │
        └── silence for FOLLOWUP_HOURS
                    ▼
            Bot nudges you in the review channel with a
            "Text them a nudge" button → RingCentral SMS
```

Nothing reaches a client without a human pressing a button. Discord is the
default because that is where the setup happened; SMS is one click away for the
agents who never joined.

## What the client receives

> Hey @Dana 👋
>
> Your **Local Services Ads** setup is complete on our end and ready to go live
> **Friday, August 21, 2026** at 9:00 AM ET.
>
> 📄 **Your sheet:** https://docs.google.com/spreadsheets/d/…
>
> Could you confirm Friday works on your end? If you'd rather launch a different
> day, just let us know here and we'll move it.
>
> — The Onboarding Team

The SMS says the same thing without the Discord formatting. Both are edited in
`config/messages.json` — no code involved. See [Changing the wording](#changing-the-wording).

## Setup

### 1. Trello: add the custom fields

The bot reads everything from the card, so the card has to carry it. On your
board, turn on the **Custom Fields** power-up and add these:

| Field | Type | Required | Example |
| --- | --- | --- | --- |
| Client Name | Text | recommended | `Acme Plumbing` |
| Campaign | Text | optional | `Local Services Ads` |
| Go Live Date | Date *or* Text | **yes** | `2026-08-21`, `Friday`, `tomorrow` |
| Go Live Time | Text | optional | `9:00 AM` |
| Timezone | Text | optional | `ET` |
| Google Sheet | Text | **yes** | the sheet URL |
| Discord Channel ID | Text | for Discord | `987654321098765432` |
| Agent Discord ID | Text | recommended | `123456789012345678` |
| Agent Name | Text | optional | `Dana` |
| Agent Phone | Text | for SMS | `(555) 010-2233` |
| Hub Link | Text | optional | the client's internal hub record |

Names are matched loosely — case, spaces, dashes and underscores are ignored, and
common alternatives (`Launch Date`, `Sheet Link`, `Phone`, …) already work. If
your board uses different names, add them to `config/fields.json` instead of
renaming anything in Trello.

**Getting Discord IDs:** in Discord, Settings → Advanced → Developer Mode, then
right-click a channel or a person → Copy ID.

**Get an API key and token:** open <https://trello.com/power-ups/admin>, create a
Power-Up for your workspace, and use its API key; generate a token from the same
page. The token only needs read access to the board.

### 2. Discord: create the bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → Reset Token → copy it into `DISCORD_TOKEN`.
3. On the same page enable **Message Content Intent**. The bot uses it to quote a
   client's reply back to your team; without it replies are still detected, just
   without the quoted text.
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permissions
   *View Channels*, *Send Messages*, *Embed Links*, *Read Message History*. Open
   the generated URL and invite the bot to your server.
5. Make sure the bot can see **both** your internal review channel and every
   client setup channel it will post in.

### 3. RingCentral (optional — the SMS fallback)

Skip this and the bot still works; the SMS buttons stay greyed out.

1. <https://developers.ringcentral.com> → create an app of type *REST API*, auth
   type **JWT**, with the **SMS** permission.
2. Copy the Client ID and Client Secret, and generate a JWT credential.
3. `RINGCENTRAL_FROM_NUMBER` is the RingCentral number texts go out from, in
   `+15551234567` form.
4. Sandbox testing: set `RINGCENTRAL_SERVER_URL=https://platform.devtest.ringcentral.com`.

### 4. Install and run

```bash
npm install
cp .env.example .env      # then fill it in
npm run register          # registers /notify and /pending on your server
npm start
```

Set `DRY_RUN=1` in `.env` for a first pass: everything works exactly the same,
but outbound messages are printed to the console instead of delivered, and the
review card is stamped 🧪 DRY_RUN.

To keep it running on a server, any process manager will do:

```bash
npm install --global pm2
pm2 start src/index.js --name onboarding-bot
pm2 save
```

## Daily use

**Send a go-live notice**

```
/notify card: https://trello.com/c/AbCd1234
```

Options:

- `date:` — override the card's date for this send (`tomorrow`, `Friday`, `8/24`,
  `2026-08-24`). Useful when the card says one thing and the client agreed another.
- `channel:` — override the client's Discord channel, for a card that has not
  been filled in yet.

The draft lands in your review channel. Press **Approve & send on Discord**, or
**Send as SMS instead** for an agent who is not on Discord, or **Edit** to reword
it, or **Discard**.

**Check what is outstanding**

```
/pending
```

Lists every client who has not yet confirmed their go-live date, soonest first,
and whether they were messaged on Discord, by text, or not yet at all.

**When they don't answer.** After `FOLLOWUP_HOURS` (default 4) the bot posts in
the review channel: *"Acme Plumbing — no reply on Discord yet. Their go-live is
still unconfirmed."* with a **Text them a nudge** button. One click sends a short
SMS pointing them back at the Discord thread. It raises this once per client, not
repeatedly.

**When they do answer,** in their setup channel, the bot marks it confirmed,
posts their reply in the review channel, and stops chasing.

## Changing the wording

`config/messages.json` holds all three messages (`discord`, `sms`, `smsNudge`).
Edits take effect on the next `/notify` — no restart.

- `{placeholder}` is filled from the card.
- `[[ ... ]]` wraps a chunk that disappears when something inside it is empty, so
  a card with no launch time still reads properly.

Available: `agentMention`, `agentName`, `clientName`, `campaignLabel`, `teamName`,
`goLiveLong` (*Friday, August 21, 2026*), `goLiveShort` (*Fri, Aug 21*),
`goLiveWeekday` (*Friday*), `goLiveRelative` (*tomorrow*), `goLiveTime`,
`timezoneLabel`, `sheetUrl`, `hubUrl`.

## How dates are handled

A launch day is a day on a calendar, so the bot treats it as one and never as a
timestamp — that is how "Friday" turns into Thursday for someone in another
timezone.

- `Friday` said on a Thursday means tomorrow. A weekday name always means the
  **next** one, never today.
- `8/24` with no year means this year, unless that already passed by more than a
  week — then it means next year.
- A Trello **Date** field stores a moment in UTC, so the bot converts it to
  `DEFAULT_TIMEZONE` to work out which day was meant. If your team and clients
  are in very different timezones, a **Text** field (`2026-08-21`) removes the
  ambiguity entirely.
- The resolved date is shown in full on the review card — *Friday, August 21,
  2026 (tomorrow)* — precisely so a wrong one gets caught before it is sent.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| ⛔ *No go-live date* / *No Google Sheet link* | The Trello card is missing that field. Fill it in and run `/notify` again, or use `date:`. |
| ⛔ *Cannot see channel* | The bot was never added to that client's channel, or the ID on the card is wrong. |
| ⚠️ *Discord delivery is unavailable* | No Discord Channel ID on the card. SMS still works. |
| SMS buttons greyed out | RingCentral is not configured, or the card's phone number could not be read. |
| *Trello rejected the request (401)* | `TRELLO_KEY`/`TRELLO_TOKEN` are wrong, or the token cannot read that board. |
| *You are not on the approver list* | Your Discord user ID is not in `APPROVER_IDS`. Leave that variable blank to let anyone in the review channel approve. |
| Replies are detected but not quoted | Message Content Intent is off in the Discord developer portal. |

Sent history lives in `data/state.json` — plain JSON, safe to open and read when
you want to know exactly what went out to whom and when.

## Deliberately left manual

- **Approval.** The bot never messages a client on its own. A wrong go-live date
  sent automatically costs more than the click saves.
- **Trello.** The bot only reads. Moving cards and marking them done stays yours.
- **The reply itself.** When a client asks for a different date, that is a
  conversation, not a workflow — the bot steps back and lets you answer.

## Tests

```bash
npm test
```

Covers date parsing (the part most likely to tell a client the wrong day),
message building and its validation, Trello field mapping, and the state store.

## Layout

```
src/
  index.js              bot startup, event wiring, follow-up sweep
  config.js             environment loading and validation
  trello.js             card fetching, custom-field mapping
  dates.js              calendar-date parsing and formatting
  message.js            card -> draft, plus every "do not send this yet" check
  template.js           the {placeholder} / [[optional]] renderer
  store.js              JSON record of every draft, send and reply
  discord/
    commands.js         /notify and /pending
    review.js           the review card: embed and buttons
    interactions.js     button and edit-modal handling
    actions.js          sending, follow-ups, reply detection
  services/
    ringcentral.js      JWT auth and SMS
config/
  fields.json           Trello field names -> what the bot needs
  messages.json         the client-facing copy
```
