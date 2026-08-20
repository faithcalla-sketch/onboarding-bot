import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft, normalizePhone, normalizeSnowflake } from '../src/message.js';

const NOW = new Date('2026-08-20T19:00:00Z'); // Thursday
const TZ = 'America/New_York';

function card(overrides = {}) {
  return {
    id: 'card1',
    name: 'Acme Plumbing — Setup',
    url: 'https://trello.com/c/AbCd1234',
    listName: 'Ready to Launch',
    due: '',
    ...overrides,
    fields: {
      clientName: 'Acme Plumbing',
      campaignName: 'Local Services Ads',
      agentName: 'Dana',
      agentDiscordId: '123456789012345678',
      discordChannelId: '987654321098765432',
      agentPhone: '(555) 010-2233',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
      goLiveDate: 'tomorrow',
      ...overrides.fields,
    },
  };
}

const build = (overrides) =>
  buildDraft({ card: card(overrides), now: NOW, timezone: TZ, ...overrides.args });

test('a complete card produces a sendable draft', async () => {
  const draft = await build({});
  assert.equal(draft.goLiveDate, '2026-08-21');
  assert.deepEqual(draft.problems, []);
  assert.deepEqual(draft.warnings, []);
  assert.equal(draft.canSendDiscord, true);
  assert.match(draft.discordBody, /<@123456789012345678>/);
  assert.match(draft.discordBody, /Friday, August 21, 2026/);
  assert.match(draft.discordBody, /docs\.google\.com\/spreadsheets\/d\/abc\/edit/);
  assert.match(draft.discordBody, /confirm Friday/);
});

test('the SMS says the same thing without Discord markup', async () => {
  const draft = await build({});
  assert.match(draft.smsBody, /Fri, Aug 21/);
  assert.match(draft.smsBody, /docs\.google\.com/);
  assert.doesNotMatch(draft.smsBody, /\*\*/);
  assert.doesNotMatch(draft.smsBody, /<@/);
});

test('a command-line date beats the card, and is recorded as such', async () => {
  const draft = await buildDraft({
    card: card(),
    dateOverride: 'Monday',
    now: NOW,
    timezone: TZ,
  });
  assert.equal(draft.goLiveDate, '2026-08-24');
  assert.equal(draft.dateSource, 'command');
  assert.match(draft.discordBody, /Monday, August 24, 2026/);
});

test('a missing date or sheet blocks the send instead of sending something wrong', async () => {
  const draft = await build({ fields: { goLiveDate: '', sheetUrl: '' } });
  assert.equal(draft.canSendDiscord, false);
  assert.equal(draft.problems.length, 2);
  assert.match(draft.problems.join(' '), /Go Live Date/);
  assert.match(draft.problems.join(' '), /Google Sheet/);
});

test('an unreadable date is reported as a problem, not thrown', async () => {
  const draft = await build({ fields: { goLiveDate: 'whenever they feel like it' } });
  assert.equal(draft.goLiveDate, null);
  assert.match(draft.problems.join(' '), /Could not read/);
});

test('a past or weekend go-live is a warning, not a block', async () => {
  const past = await build({ fields: { goLiveDate: '2026-08-18' } });
  assert.deepEqual(past.problems, []);
  assert.match(past.warnings.join(' '), /in the past/);

  const weekend = await build({ fields: { goLiveDate: 'Saturday' } });
  assert.match(weekend.warnings.join(' '), /weekend/);
  assert.equal(weekend.canSendDiscord, true);
});

test('no Discord channel disables Discord but keeps SMS on the table', async () => {
  const draft = await build({ fields: { discordChannelId: '' } });
  assert.equal(draft.canSendDiscord, false);
  assert.deepEqual(draft.problems, []);
  assert.match(draft.warnings.join(' '), /Discord delivery is unavailable/);
  assert.equal(draft.phone, '+15550102233');
});

test('no channel and no phone is a hard stop', async () => {
  const draft = await build({ fields: { discordChannelId: '', agentPhone: '' } });
  assert.match(draft.problems.join(' '), /neither a Discord channel nor a usable phone/);
});

test('the go-live time and timezone label are carried into both messages', async () => {
  const draft = await build({ fields: { goLiveTime: '9:00 AM', timezoneLabel: 'ET' } });
  assert.match(draft.discordBody, /at 9:00 AM ET/);
  assert.match(draft.smsBody, /at 9:00 AM ET/);
});

test('a card with no campaign still reads naturally', async () => {
  const draft = await build({ fields: { campaignName: '' } });
  assert.match(draft.discordBody, /Your setup is complete on our end/);
});

test('a card with no agent ID sends without an @mention, and says so', async () => {
  const draft = await build({ fields: { agentDiscordId: '' } });
  assert.match(draft.discordBody, /Hey Dana/);
  assert.match(draft.warnings.join(' '), /will not @mention/);
  assert.equal(draft.canSendDiscord, true);
});

test('a sheet link that is not a Google Sheet is flagged', async () => {
  const draft = await build({ fields: { sheetUrl: 'https://example.com/thing' } });
  assert.match(draft.warnings.join(' '), /not a docs\.google\.com/);
});

test('phone numbers survive however they were typed on the card', () => {
  assert.equal(normalizePhone('(555) 010-2233'), '+15550102233');
  assert.equal(normalizePhone('555-010-2233'), '+15550102233');
  assert.equal(normalizePhone('15550102233'), '+15550102233');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('ask Dana'), null);
  assert.equal(normalizePhone('555-0102'), null);
  assert.equal(normalizePhone(''), null);
});

test('Discord IDs are accepted raw or as mentions', () => {
  assert.equal(normalizeSnowflake('123456789012345678'), '123456789012345678');
  assert.equal(normalizeSnowflake('<@123456789012345678>'), '123456789012345678');
  assert.equal(normalizeSnowflake('<#123456789012345678>'), '123456789012345678');
  assert.equal(normalizeSnowflake('<@!123456789012345678>'), '123456789012345678');
  assert.equal(normalizeSnowflake('nope'), null);
  assert.equal(normalizeSnowflake('12345'), null);
});

test('the card due date is the last resort for a go-live date', async () => {
  const draft = await buildDraft({
    card: { ...card({ fields: { goLiveDate: '' } }), due: '2026-08-25T16:00:00.000Z' },
    now: NOW,
    timezone: TZ,
  });
  assert.equal(draft.goLiveDate, '2026-08-25');
  assert.equal(draft.dateSource, 'due');
});

test('over-long copy is caught before Discord rejects it', async () => {
  const draft = await buildDraft({
    card: card(),
    now: NOW,
    timezone: TZ,
    messages: {
      discord: `${'x'.repeat(2100)} {goLiveLong}`,
      sms: 'short',
      smsNudge: 'short',
    },
  });
  assert.match(draft.problems.join(' '), /limit is 2000/);
  assert.equal(draft.canSendDiscord, false);
});
