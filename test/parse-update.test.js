import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFromComments,
  findChannel,
  findClientName,
  findDateIn,
  findGoLiveDate,
  findPhone,
  findSheetUrl,
  parseUpdate,
  scoreUpdate,
} from '../src/parse-update.js';
import { parseGoLive } from '../src/dates.js';

// The update as the systems person actually writes it.
const REAL_UPDATE = `OTP FX on this show hub setup is complete for Jando
Fire the test in the Discord channel and you will see to ensure it is working properly
Added email SMS notification
Client is ready to go live on Friday, August 21
https://docs.google.com/spreadsheets/d/1AbCdEf/edit
#jando-setup`;

test('the real update is read end to end', () => {
  const parsed = parseUpdate(REAL_UPDATE);
  assert.equal(parsed.clientName, 'Jando');
  assert.equal(parsed.goLiveDate, 'August 21');
  assert.equal(parsed.goLiveDateConfident, true);
  assert.equal(parsed.sheetUrl, 'https://docs.google.com/spreadsheets/d/1AbCdEf/edit');
  assert.equal(parsed.channelName, 'jando-setup');
  assert.ok(parsed.score >= 4, 'it reads clearly as a setup update');
});

test('the parsed date resolves to the day the team meant', () => {
  const parsed = parseUpdate(REAL_UPDATE);
  const resolved = parseGoLive(parsed.goLiveDate, {
    timezone: 'America/New_York',
    now: new Date('2026-08-20T19:00:00Z'), // the Thursday before
  });
  assert.equal(resolved, '2026-08-21');
});

test('ordinary card chatter is not mistaken for an update', () => {
  assert.equal(scoreUpdate('just bumping this card'), 0);
  assert.equal(scoreUpdate('waiting on the client to send their logo'), 0);
  assert.equal(parseUpdate('any update here?').goLiveDate, null);
});

test('the client name is picked out of the sentence around it', () => {
  assert.equal(findClientName('hub setup is complete for Jando'), 'Jando');
  assert.equal(findClientName('Setup complete for Acme Plumbing.'), 'Acme Plumbing');
  assert.equal(findClientName('OTP FX on this show hub setup is complete for Jando'), 'Jando');
  assert.equal(findClientName('Client: Acme Plumbing'), 'Acme Plumbing');
  assert.equal(findClientName("setup is complete for Dana's Diner - all good"), "Dana's Diner");
  assert.equal(findClientName('nothing to see here'), null);
});

test('the go-live date is taken from the phrase that announces it', () => {
  const cases = [
    ['Client is ready to go live on Friday, August 21', 'August 21'],
    ['ready to go live on 8/24', '8/24'],
    ['Ready to go live on 2026-08-24', '2026-08-24'],
    ['goes live on Monday', 'Monday'],
    ['Launch date: August 24, 2026', 'August 24, 2026'],
    ['go-live date is 8/24/2026', '8/24/2026'],
    ['launching on tomorrow', 'tomorrow'],
    ['Client is ready to go live on his start date, Monday', 'Monday'],
  ];
  for (const [text, expected] of cases) {
    const found = findGoLiveDate(text);
    assert.equal(found?.raw, expected, `from: ${text}`);
    assert.equal(found?.confident, true, `from: ${text}`);
  }
});

test('a weekday plus a real date prefers the real date', () => {
  assert.equal(findDateIn('Friday, August 21'), 'August 21');
  assert.equal(findDateIn('Monday 8/24'), '8/24');
  assert.equal(findDateIn('Friday'), 'Friday');
});

test('a date with nothing announcing it is flagged as a guess', () => {
  const found = findGoLiveDate('setup is complete for Jando. 8/24 is the day.');
  assert.equal(found.raw, '8/24');
  assert.equal(found.confident, false, 'nothing said "go live on", so it needs a look');
});

test('dates are never scavenged out of URLs', () => {
  const found = findGoLiveDate(
    'setup complete https://docs.google.com/spreadsheets/d/1-2-3456/edit',
  );
  assert.equal(found, null);
});

test('the sheet link is found wherever it sits', () => {
  assert.equal(
    findSheetUrl('sheet: https://docs.google.com/spreadsheets/d/abc123/edit#gid=0 thanks'),
    'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0',
  );
  assert.equal(
    findSheetUrl('(https://docs.google.com/spreadsheets/d/abc123/edit)'),
    'https://docs.google.com/spreadsheets/d/abc123/edit',
  );
  // Trailing sentence punctuation is not part of the URL.
  assert.equal(
    findSheetUrl('here it is https://docs.google.com/spreadsheets/d/abc123/edit.'),
    'https://docs.google.com/spreadsheets/d/abc123/edit',
  );
  assert.equal(findSheetUrl('https://drive.google.com/file/d/xyz'), null);
});

test('the Discord channel is understood however it is written', () => {
  assert.deepEqual(findChannel('<#987654321098765432>'), { id: '987654321098765432' });
  assert.deepEqual(findChannel('channel id: 987654321098765432'), { id: '987654321098765432' });
  assert.deepEqual(findChannel('987654321098765432'), { id: '987654321098765432' });
  assert.deepEqual(
    findChannel('https://discord.com/channels/111111111111111111/987654321098765432'),
    { id: '987654321098765432' },
  );
  assert.deepEqual(findChannel('posted in #jando-setup'), { name: 'jando-setup' });
  assert.equal(findChannel('no channel mentioned'), null);
  // A phone number must never be read as a channel.
  assert.equal(findChannel('call them on 555-010-2233'), null);
});

test('a phone number is only taken when it is labelled as one', () => {
  assert.equal(findPhone('phone: (555) 010-2233'), '(555) 010-2233');
  assert.equal(findPhone('SMS number - +1 555 010 2233'), '+1 555 010 2233');
  // Not every long number in an update is a phone number.
  assert.equal(findPhone('order 5550102233 was processed'), null);
});

test('parts posted across separate comments are gathered together', () => {
  const comments = [
    {
      id: 'c3',
      date: '2026-08-20T14:10:00Z',
      author: 'Systems',
      text: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
    },
    {
      id: 'c2',
      date: '2026-08-20T14:05:00Z',
      author: 'Systems',
      text: 'Hub setup is complete for Jando. Fire the test in the Discord channel. Added email SMS notification. Client is ready to go live on Friday, August 21.',
    },
    { id: 'c1', date: '2026-08-19T09:00:00Z', author: 'CSR', text: 'client onboarded' },
  ];

  const result = extractFromComments(comments);
  assert.equal(result.values.clientName, 'Jando');
  assert.equal(result.values.goLiveDate, 'August 21');
  assert.equal(result.values.sheetUrl, 'https://docs.google.com/spreadsheets/d/sheet-123/edit');
  // Each value remembers the comment it came from.
  assert.equal(result.sources.goLiveDate, 'c2');
  assert.equal(result.sources.sheetUrl, 'c3');
  assert.equal(result.anchor.id, 'c2', 'the setup-complete comment anchors the read');
});

test('the newest setup update wins when a card has been through it twice', () => {
  const comments = [
    {
      id: 'new',
      date: '2026-08-20T14:00:00Z',
      text: 'Hub setup is complete for Jando. Ready to go live on August 24.',
    },
    {
      id: 'old',
      date: '2026-07-01T14:00:00Z',
      text: 'Hub setup is complete for Jando. Ready to go live on July 3.',
    },
  ];
  const result = extractFromComments(comments);
  assert.equal(result.anchor.id, 'new');
  assert.equal(result.values.goLiveDate, 'August 24');
});

test('a card with no setup update yields nothing rather than a guess', () => {
  assert.equal(extractFromComments([]), null);
  assert.equal(
    extractFromComments([{ id: 'c1', date: '2026-08-20T14:00:00Z', text: 'bumping' }]),
    null,
  );
});

test('the internal checklist wording is never treated as content', () => {
  const result = extractFromComments([
    {
      id: 'c1',
      date: '2026-08-20T14:00:00Z',
      text: REAL_UPDATE,
    },
  ]);
  // "Fire the test" and "email SMS notification" are evidence, not values.
  assert.equal(result.values.clientName, 'Jando');
  assert.ok(!Object.values(result.values).some((value) => /fire the test/i.test(String(value))));
  assert.ok(!Object.values(result.values).some((value) => /notification/i.test(String(value))));
});
