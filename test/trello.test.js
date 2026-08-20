import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFieldMap, mapCustomFields, parseCardRef, readFieldValue } from '../src/trello.js';

test('card references are accepted as URLs, short links or ids', () => {
  assert.equal(parseCardRef('https://trello.com/c/AbCd1234/57-acme-plumbing-setup'), 'AbCd1234');
  assert.equal(parseCardRef('https://trello.com/c/AbCd1234'), 'AbCd1234');
  assert.equal(parseCardRef('  AbCd1234  '), 'AbCd1234');
  assert.equal(parseCardRef('5f2b8c1d9e4a3b2c1d0e9f8a'), '5f2b8c1d9e4a3b2c1d0e9f8a');
  assert.throws(() => parseCardRef('not a card'), /does not look like a Trello card/);
  assert.throws(() => parseCardRef(''), /No Trello card given/);
});

test('every custom field shape Trello can return is read as a string', () => {
  assert.equal(readFieldValue({ value: { text: 'Acme' } }), 'Acme');
  assert.equal(readFieldValue({ value: { number: '42' } }), '42');
  assert.equal(readFieldValue({ value: { date: '2026-08-21T00:00:00.000Z' } }), '2026-08-21T00:00:00.000Z');
  assert.equal(readFieldValue({ value: { checked: 'true' } }), 'true');
  assert.equal(
    readFieldValue({ idValue: 'opt2' }, { options: [{ id: 'opt1', value: { text: 'A' } }, { id: 'opt2', value: { text: 'B' } }] }),
    'B',
  );
  assert.equal(readFieldValue(null), '');
  assert.equal(readFieldValue({ value: null }), '');
});

test('field names match regardless of case, spacing or punctuation', async () => {
  const fieldMap = await loadFieldMap();
  const definitions = [
    { id: 'f1', name: 'go live date' },
    { id: 'f2', name: 'Google  Sheet' },
    { id: 'f3', name: 'DISCORD_CHANNEL_ID' },
    { id: 'f4', name: 'Agent-Phone' },
  ];
  const items = [
    { idCustomField: 'f1', value: { text: 'Friday' } },
    { idCustomField: 'f2', value: { text: 'https://docs.google.com/spreadsheets/d/x' } },
    { idCustomField: 'f3', value: { text: '987654321098765432' } },
    { idCustomField: 'f4', value: { text: '555-010-2233' } },
  ];
  const { fields, unmatched } = mapCustomFields(definitions, items, fieldMap);
  assert.equal(fields.goLiveDate, 'Friday');
  assert.equal(fields.discordChannelId, '987654321098765432');
  assert.equal(fields.agentPhone, '555-010-2233');
  assert.match(fields.sheetUrl, /docs\.google\.com/);
  assert.deepEqual(unmatched, []);
});

test('fields the bot does not know about are kept, not dropped', async () => {
  const fieldMap = await loadFieldMap();
  const definitions = [
    { id: 'f1', name: 'Go Live Date' },
    { id: 'f9', name: 'Ad Budget' },
  ];
  const items = [
    { idCustomField: 'f1', value: { text: '2026-08-21' } },
    { idCustomField: 'f9', value: { number: '1500' } },
  ];
  const { fields, extra, unmatched } = mapCustomFields(definitions, items, fieldMap);
  assert.equal(fields.goLiveDate, '2026-08-21');
  assert.equal(extra['Ad Budget'], '1500');
  assert.deepEqual(unmatched, ['Ad Budget']);
});

test('empty values and orphaned items are ignored', async () => {
  const fieldMap = await loadFieldMap();
  const definitions = [{ id: 'f1', name: 'Go Live Date' }];
  const items = [
    { idCustomField: 'f1', value: { text: '' } },
    { idCustomField: 'gone', value: { text: 'orphan' } },
  ];
  const { fields } = mapCustomFields(definitions, items, fieldMap);
  assert.equal(fields.goLiveDate, undefined);
});
