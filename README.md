# Onboarding Bot

Re-confirms a client's go-live date on Discord — or by text when they never
joined Discord — from the setup update your systems person already writes on
Trello.

The date itself was agreed with the client by their CSR long before this point.
This bot is not asking them to approve anything. It tells them the setup is
finished, re-states the live date they already have, and hands them their sheet.

## The flow

```
Systems person finishes the setup and comments on the Trello card:

    OTP FX on this show hub setup is complete for Jando
    Fire the test in the Discord channel and you will see to ensure it works
    Added email SMS notification
    Client is ready to go live on Friday, August 21
    https://docs.google.com/spreadsheets/d/.../edit
    #jando-setup
        │
        │  you run:  /notify card:<trello link>
        ▼
Bot reads that update: client, live date, sheet link, Discord channel
        │
        ▼
Draft appears in your internal review channel, showing the update it read
and where each value came from
   ⛔ no date or no sheet?  it says so and refuses to send
   ⚠️  date is in the past, on a weekend, or was only guessed?  it flags it
        │
        │  you press "Approve & send on Discord"
        ▼
Message posts in the client's setup channel
        │
        ├── client replies  ──►  logged, team notified, chasing stops
        │
        └── silence for FOLLOWUP_HOURS
                    ▼
            Bot flags it in the review channel with a
            "Text them a nudge" button → RingCentral SMS
```

Nothing reaches a client without a human pressing a button.

## What the client receives

> Hey @Dana 👋
>
> Good news — your **Local Services Ads** setup is complete on our end, and
> everything is ready for your launch on **Friday, August 21, 2026** (tomorrow).
>
> 📄 **Your sheet:** https://docs.google.com/spreadsheets/d/…
>
> Nothing needed from you — we just wanted to re-confirm your live date now that
> the setup is done. If anything has changed on your end, let us know here and
> we'll sort it out.
>
> — The Onboarding Team

The SMS says the same without the Discord formatting. Both live in
`config/messages.json` — see [Changing the wording](#changing-the-wording).

**The internal checklist never reaches the client.** "Fire the test", "added
email SMS notification", "OTP FX", "hub setup" — the bot uses that wording only
to recognise which comment is the setup update. None of it is quoted onward.

## What the bot needs in the Trello update

Three things, written however your systems person normally writes them:

| What | How she already writes it | Also accepted |
| --- | --- | --- |
| **Client** | `hub setup is complete for Jando` | `Setup complete for Acme`, `Client: Acme` |
| **Live date** | `Client is ready to go live on Friday, August 21` | `ready to go live on 8/24`, `Launch date: Aug 24`, `goes live on Monday` |
| **Sheet** | the `docs.google.com/spreadsheets/…` link, anywhere in the update | posted as its own follow-up comment |

Plus the one thing to start adding:

| What | How to write it |
| --- | --- |
| **Discord channel** | `#jando-setup` — the channel name is enough. `<#987654321098765432>`, a raw channel ID, or a `discord.com/channels/…` link all work too. |

Notes on how it reads them:

- **The parts can be spread across comments.** The comment that says "setup is
  complete" / "ready to go live" anchors the read; anything missing from it is
  looked for in the comments around it, so posting the sheet link separately is
  fine.
- **The newest setup update wins** if a card has been through this more than once.
- **A channel name is matched against your server** when you run `/notify`.
  An ambiguous name resolves to nothing rather than to a guess — posting a
  client's details in the wrong channel is worse than not posting.
- **A date with nothing announcing it** (a bare `8/24` with no "go live on") is
  still picked up, but flagged on the review card for a second look.

### Optional: Trello custom fields

The bot works with no custom fields at all. If your board has them, they win over
anything parsed out of prose, because a named box is somebody being deliberate.

`Client Name`, `Campaign`, `Go Live Date`, `Go Live Time`, `Timezone`,
`Google Sheet`, `Discord Channel ID`, `Agent Discord ID`, `Agent Name`,
`Agent Phone`, `Hub Link`.

Names match loosely (case, spaces, dashes ignored) and common alternatives —
`Launch Date`, `Sheet Link`, `Phone` — already work. Add your own to
`config/fields.json` rather than renaming anything in Trello.

`Agent Phone` is the one worth adding early: it is what makes the SMS fallback
possible for agents who never join Discord.

## Setup

### 1. Trello access

Open <https://trello.com/power-ups/admin>, create a Power-Up for your workspace,
use its API key, and generate a token from the same page. Read access to the
board is enough.

### 2. Discord bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** → Reset Token → copy into `DISCORD_TOKEN`.
3. Enable **Message Content Intent** on the same page. It is used to quote a
   client's reply back to your team; without it replies are still detected, just
   not quoted.
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`,
   permissions *View Channels*, *Send Messages*, *Embed Links*,
   *Read Message History*. Open the URL and invite the bot.
5. The bot must be able to see your internal review channel **and** every client
   setup channel it will post in.

**Getting Discord IDs:** Settings → Advanced → Developer Mode, then right-click
a channel or person → Copy ID.

### 3. RingCentral (optional — the SMS fallback)

Skip it and the bot still works; the SMS buttons stay greyed out.

1. <https://developers.ringcentral.com> → create a *REST API* app, auth type
   **JWT**, with the **SMS** permission.
2. Copy the Client ID and Secret, generate a JWT credential.
3. `RINGCENTRAL_FROM_NUMBER` is the number texts go out from, as `+15551234567`.
4. Sandbox: `RINGCENTRAL_SERVER_URL=https://platform.devtest.ringcentral.com`.

### 4. Install and run

```bash
npm install
cp .env.example .env      # then fill it in
npm run register          # registers /notify and /pending on your server
npm start
```

To keep it running on a server:

```bash
npm install --global pm2
pm2 start src/index.js --name onboarding-bot
pm2 save
```

### 5. Check it reads your real cards — before it messages anyone

```bash
npm run check -- https://trello.com/c/AbCd1234
```

This reads a real card and prints the update it found, what it took from it,
where each value came from, and the exact message the client would get. It sends
nothing and does not need Discord running. Run it against a handful of recent
cards first — that is how you find out whether the wording on your board parses
cleanly.

Then set `DRY_RUN=1` in `.env` for the first live pass: the whole flow works,
but outbound messages print to the console instead of being delivered, and the
review card is stamped 🧪 DRY_RUN.

## Daily use

**Send a go-live notice**

```
/notify card: https://trello.com/c/AbCd1234
```

Options:

- `date:` — override the live date for this send (`tomorrow`, `Friday`, `8/24`,
  `2026-08-24`). Use it when the update is wrong or missing a date.
- `channel:` — override the client's Discord channel.

The draft lands in your review channel showing the Trello update it read and a
**Read from** line for the date, sheet and channel. Press **Approve & send on
Discord**, or **Send as SMS instead** for an agent who is not on Discord, or
**Edit** to reword it, or **Discard**.

**Check what is outstanding**

```
/pending
```

Every client who has not come back to us, soonest live date first, and whether
they were messaged on Discord, by text, or not yet.

**When they don't answer.** After `FOLLOWUP_HOURS` (default 4) the bot posts in
the review channel — *"Jando — no reply on Discord, they may not be in the
channel"* — with a **Text them a nudge** button. The nudge SMS carries the live
date and the sheet link, so it stands on its own for an agent who never joined
Discord. Raised once per client, not repeatedly.

**When they do reply,** the bot logs it, posts their message in the review
channel, and stops chasing. Nothing was being asked of them, so a reply is not
an approval — it is proof the notice landed, and occasionally a change of plan
for you to handle.

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

Keep it re-confirming rather than asking. The client agreed this date with their
CSR weeks ago; wording that sounds like it is reopening the question invites a
renegotiation nobody wanted.

## How dates are handled

A launch day is a day on a calendar, so the bot treats it as one and never as a
timestamp — that is how "Friday" arrives as Thursday for someone in another
timezone.

- `Friday` said on a Thursday means tomorrow. A weekday name always means the
  **next** one, never today.
- `Friday, August 21` resolves on *August 21*, not on the word Friday.
- `8/24` with no year means this year, unless that already passed by more than a
  week — then next year.
- A Trello **Date** field stores a moment in UTC, so it is converted to
  `DEFAULT_TIMEZONE` to work out which day was meant.
- The resolved date is shown in full on the review card — *Friday, August 21,
  2026 (tomorrow)* — precisely so a wrong one gets caught before it is sent.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| ⛔ *No go-live date* | The update never said "ready to go live on …". Add it to the card, or pass `date:`. |
| ⛔ *No Google Sheet link* | No spreadsheet URL in the update or in a `Google Sheet` field. |
| ⛔ *Cannot see channel* | The bot was never added to that client's channel, or the ID is wrong. |
| ⚠️ *no channel by that name is visible* | The `#name` in the update does not match a channel the bot can see, or matches more than one. Check the name or pass `channel:`. |
| ⚠️ *the update never says "go live on …"* | The date was picked out of loose text. Read it before approving. |
| ⚠️ *No setup-complete update was found* | No comment on the card reads as a setup update. Check the wording with `npm run check`. |
| SMS buttons greyed out | RingCentral is not configured, or there is no usable phone number for that client. |
| *Trello rejected the request (401)* | `TRELLO_KEY`/`TRELLO_TOKEN` are wrong, or the token cannot read that board. |
| *You are not on the approver list* | Your Discord user ID is not in `APPROVER_IDS`. Leave that variable blank to let anyone in the review channel approve. |
| Replies detected but not quoted | Message Content Intent is off in the Discord developer portal. |

Sent history lives in `data/state.json` — plain JSON, safe to open, and the
record of exactly what went to whom and when.

## Deliberately left manual

- **Approval.** The bot never messages a client on its own. It is reading prose
  written by a person; a human confirming the reading costs one click and is the
  whole reason a misparse cannot reach a client.
- **The trigger.** You run `/notify` when the setup is done. Now that the update
  comment is what the bot reads, watching the board for new ones is a
  straightforward next step if you want it.
- **Trello.** The bot only reads. Moving cards and marking them done stays yours.
- **The reply.** If a client comes back asking for a different date, that is a
  conversation, not a workflow.

## Tests

```bash
npm test
```

82 tests, covering the update parser (the riskiest part — it reads prose), date
handling, message building and its refusals, Trello field mapping, the state
store, RingCentral, and the send / reply / follow-up flow end to end.

## Layout

```
src/
  index.js              bot startup, event wiring, follow-up sweep
  config.js             environment loading and validation
  trello.js             card + comment fetching, custom-field mapping
  parse-update.js       reads the systems person's setup update
  dates.js              calendar-date parsing and formatting
  message.js            card -> draft, provenance, and every refusal
  template.js           the {placeholder} / [[optional]] renderer
  store.js              JSON record of every draft, send and reply
  discord/
    commands.js         /notify and /pending, channel-name matching
    review.js           the review card: embed and buttons
    interactions.js     button and edit-modal handling
    actions.js          sending, follow-ups, reply detection
  services/
    ringcentral.js      JWT auth and SMS
scripts/
  register-commands.js  one-time slash-command registration
  check-card.js         dry read of a real card, sends nothing
config/
  fields.json           Trello field names -> what the bot needs
  messages.json         the client-facing copy
```
