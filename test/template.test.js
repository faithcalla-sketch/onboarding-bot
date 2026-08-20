import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, templateKeys } from '../src/template.js';
import { loadMessages } from '../src/message.js';

test('placeholders are substituted', () => {
  assert.equal(renderTemplate('Hi {name}!', { name: 'Dana' }), 'Hi Dana!');
});

test('optional groups vanish when a placeholder inside is empty', () => {
  const tpl = 'Live {date}[[ at {time}]].';
  assert.equal(renderTemplate(tpl, { date: 'Friday', time: '9 AM' }), 'Live Friday at 9 AM.');
  assert.equal(renderTemplate(tpl, { date: 'Friday' }), 'Live Friday.');
  assert.equal(renderTemplate(tpl, { date: 'Friday', time: '   ' }), 'Live Friday.');
});

test('optional groups can span whole lines', () => {
  const tpl = 'Sheet: {sheet}\n[[Hub: {hub}\n]]Thanks';
  assert.equal(renderTemplate(tpl, { sheet: 's', hub: 'h' }), 'Sheet: s\nHub: h\nThanks');
  assert.equal(renderTemplate(tpl, { sheet: 's' }), 'Sheet: s\nThanks');
});

test('unknown placeholders collapse instead of leaking braces', () => {
  assert.equal(renderTemplate('Hi {nope}there', {}), 'Hi there');
});

test('whitespace left by dropped groups is tidied', () => {
  const out = renderTemplate('A\n\n\n\nB[[ {x}]]  \n', {});
  assert.equal(out, 'A\n\nB');
});

test('templateKeys lists what a template needs', () => {
  assert.deepEqual(templateKeys('{a} and [[{b}]]'), ['a', 'b']);
});

test('the shipped copy only uses placeholders the bot provides', async () => {
  const messages = await loadMessages();
  const supported = new Set([
    'agentMention', 'agentName', 'clientName', 'campaignLabel', 'teamName',
    'goLiveLong', 'goLiveShort', 'goLiveWeekday', 'goLiveRelative', 'goLiveTime',
    'timezoneLabel', 'sheetUrl', 'hubUrl',
  ]);
  for (const key of ['discord', 'sms', 'smsNudge']) {
    for (const placeholder of templateKeys(messages[key])) {
      assert.ok(
        supported.has(placeholder),
        `config/messages.json "${key}" uses unknown placeholder {${placeholder}}`,
      );
    }
  }
});
