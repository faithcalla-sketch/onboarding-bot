import { assertConfig, config } from '../src/config.js';
import { loadCard } from '../src/trello.js';
import { buildDraft, SOURCE_LABELS } from '../src/message.js';
import { estimateSegments } from '../src/services/ringcentral.js';

/**
 * Reads a real Trello card and shows exactly what the bot would make of it,
 * without sending anything or needing Discord to be running.
 *
 *   npm run check -- https://trello.com/c/AbCd1234
 *
 * Use it to check the bot understands how your systems person writes updates,
 * before pointing it at a live client channel.
 */

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const YELLOW = '[33m';
const GREEN = '[32m';
const OFF = '[0m';

function heading(text) {
  console.log(`\n${BOLD}${text}${OFF}`);
}

async function main() {
  const cardRef = process.argv[2];
  if (!cardRef) {
    console.error('Usage: npm run check -- <trello card url>');
    process.exit(1);
  }

  assertConfig();
  const card = await loadCard(cardRef);

  heading(`Card: ${card.name}`);
  console.log(`${DIM}${card.url}${card.listName ? `  ·  list: ${card.listName}` : ''}${OFF}`);

  heading('Setup update found on the card');
  if (card.update) {
    const { anchor } = card.update;
    const when = anchor.date ? new Date(anchor.date).toLocaleString() : 'unknown date';
    console.log(`${DIM}${anchor.author || 'unknown'} · ${when} · confidence ${anchor.score}/7${OFF}`);
    console.log(anchor.text.split('\n').map((line) => `  │ ${line}`).join('\n'));
  } else {
    console.log(
      `${YELLOW}No setup-complete update found in the last 25 comments.${OFF}\n` +
        `${DIM}The bot looks for wording like "setup is complete", "ready to go live",\n` +
        `"fire the test", or "added email SMS notification".${OFF}`,
    );
  }

  const draft = await buildDraft({ card });

  heading('What the bot read');
  const rows = [
    ['Client', draft.clientName, draft.sources.clientName],
    ['Campaign', draft.campaignName, draft.sources.campaignName],
    ['Go-live date', draft.goLiveDate ? `${draft.goLiveDate}` : '—', draft.sources.goLiveDate],
    ['Sheet', draft.sheetUrl, draft.sources.sheetUrl],
    ['Discord channel', draft.channelId || (draft.channelName ? `#${draft.channelName}` : ''), draft.sources.channelId || draft.sources.channelName],
    ['Phone', draft.phone, draft.sources.agentPhone],
  ];
  for (const [label, value, source] of rows) {
    const shown = value || `${DIM}—${OFF}`;
    const from = source ? ` ${DIM}(from ${SOURCE_LABELS[source] || source})${OFF}` : '';
    console.log(`  ${label.padEnd(16)} ${shown}${from}`);
  }
  if (draft.channelName && !draft.channelId) {
    console.log(
      `  ${DIM}#${draft.channelName} is matched against your Discord server when the bot\n` +
        `  runs, so it cannot be checked from here. Run /notify to confirm it resolves.${OFF}`,
    );
  }

  if (card.unmatchedFieldNames?.length) {
    console.log(
      `\n  ${DIM}Custom fields the bot does not use: ${card.unmatchedFieldNames.join(', ')}${OFF}`,
    );
  }

  if (draft.problems.length) {
    heading(`${RED}Would NOT send${OFF}`);
    for (const problem of draft.problems) console.log(`  ${RED}⛔${OFF} ${problem}`);
  }
  if (draft.warnings.length) {
    heading(`${YELLOW}Worth a look${OFF}`);
    for (const warning of draft.warnings) console.log(`  ${YELLOW}⚠${OFF}  ${warning}`);
  }
  if (!draft.problems.length && !draft.warnings.length) {
    heading(`${GREEN}Ready to send${OFF}`);
  }

  heading('Discord message the client would get');
  console.log(draft.discordBody.split('\n').map((line) => `  │ ${line}`).join('\n'));

  heading(`SMS fallback (${draft.smsBody.length} chars, ${estimateSegments(draft.smsBody)} segment(s))`);
  console.log(draft.smsBody.split('\n').map((line) => `  │ ${line}`).join('\n'));

  console.log(`\n${DIM}Nothing was sent. Timezone: ${config.defaultTimezone}${OFF}`);
}

main().catch((error) => {
  console.error(`${RED}${error.message}${OFF}`);
  process.exit(1);
});
