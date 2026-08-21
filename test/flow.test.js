import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { buildDraft } from '../src/message.js';
import { deliverDiscord, recordAck, refreshReviewMessage, runFollowupSweep } from '../src/discord/actions.js';

const NOW = new Date('2026-08-20T19:00:00Z');
const CLIENT_CHANNEL = '987654321098765432';
const REVIEW_CHANNEL = '111111111111111111';
const AGENT = '123456789012345678';

const CARD = {
  id: 'card1',
  name: 'Acme Plumbing — Setup',
  url: 'https://trello.com/c/AbCd1234',
  listName: 'Ready to Launch',
  due: '',
  fields: {
    clientName: 'Acme Plumbing',
    campaignName: 'Local Services Ads',
    agentName: 'Dana',
    agentDiscordId: AGENT,
    discordChannelId: CLIENT_CHANNEL,
    agentPhone: '(555) 010-2233',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
    goLiveDate: 'tomorrow',
  },
};

/** A Discord client stubbed down to what these paths actually touch. */
function mockClient() {
  const sends = [];
  const edits = [];
  let counter = 0;
  const channels = new Map();

  function channel(id) {
    if (!channels.has(id)) {
      channels.set(id, {
        id,
        isTextBased: () => true,
        async send(payload) {
          const messageId = `msg${++counter}`;
          sends.push({ channelId: id, payload });
          return { id: messageId, url: `https://discord.com/channels/g/${id}/${messageId}` };
        },
        messages: {
          async fetch(messageId) {
            return {
              id: messageId,
              async edit(payload) {
                edits.push({ channelId: id, messageId, payload });
              },
            };
          },
        },
      });
    }
    return channels.get(id);
  }

  return {
    client: { channels: { fetch: async (id) => channel(id) } },
    sends,
    edits,
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'onboarding-flow-'));
  const store = await new Store(join(dir, 'state.json')).load();
  const draft = await buildDraft({ card: CARD, now: NOW, timezone: 'America/New_York' });
  const record = await store.create({
    draft,
    card: CARD,
    createdBy: 'staff-1',
    reviewChannelId: REVIEW_CHANNEL,
    reviewMessageId: 'review-1',
  });
  return { dir, store, record, ...mockClient() };
}

test('approving a draft posts to the client channel and arms the follow-up', async () => {
  const { dir, store, record, client, sends } = await setup();
  try {
    const updated = await deliverDiscord(client, store, record, { id: 'staff-1' });

    assert.equal(sends.length, 1);
    assert.equal(sends[0].channelId, CLIENT_CHANNEL);
    assert.match(sends[0].payload.content, /Friday, August 21, 2026/);
    assert.match(sends[0].payload.content, /docs\.google\.com/);

    // Only the agent is pinged — never @everyone, never a stray role.
    assert.deepEqual(sends[0].payload.allowedMentions, { parse: [], users: [AGENT] });

    assert.equal(updated.status, 'sent');
    assert.equal(updated.discord.sent, true);
    assert.equal(updated.discord.channelId, CLIENT_CHANNEL);
    assert.ok(updated.followupAt, 'a follow-up time is set');
    assert.ok(Date.parse(updated.followupAt) > Date.now());

    // And it is durable: a restart must not re-send or forget.
    const reopened = await new Store(store.path).load();
    assert.equal(reopened.get(record.id).discord.sent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same draft cannot be sent to the client twice', async () => {
  const { dir, store, record, client, sends } = await setup();
  try {
    const sent = await deliverDiscord(client, store, record, { id: 'staff-1' });
    await assert.rejects(
      () => deliverDiscord(client, store, sent, { id: 'staff-2' }),
      /already been sent/,
    );
    assert.equal(sends.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a draft with problems refuses to send even if the call is forced', async () => {
  const { dir, store, client, sends } = await setup();
  try {
    const broken = await buildDraft({
      card: { ...CARD, fields: { ...CARD.fields, sheetUrl: '' } },
      now: NOW,
      timezone: 'America/New_York',
    });
    const record = await store.create({ draft: broken, reviewChannelId: REVIEW_CHANNEL });
    await assert.rejects(
      () => deliverDiscord(client, store, record, { id: 'staff-1' }),
      /Fix the problems on the Trello card first/,
    );
    assert.equal(sends.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a channel the bot cannot see fails with an actionable message', async () => {
  const { dir, store, record } = await setup();
  try {
    const blindClient = { channels: { fetch: async () => null } };
    await assert.rejects(
      () => deliverDiscord(blindClient, store, record, { id: 'staff-1' }),
      /bot has been added to that channel/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the client's reply stops the chasing and tells the team", async () => {
  const { dir, store, record, client, sends, edits } = await setup();
  try {
    const sent = await deliverDiscord(client, store, record, { id: 'staff-1' });
    const reply = {
      author: { id: AGENT, tag: 'dana#0001', username: 'dana' },
      channelId: CLIENT_CHANNEL,
      content: 'Friday works for us, thanks!',
      url: 'https://discord.com/channels/g/c/reply',
    };

    const acked = await recordAck(client, store, sent, reply);
    assert.equal(acked.ack.by, AGENT);
    assert.match(acked.ack.excerpt, /Friday works/);
    assert.equal(acked.followupDone, true);

    // The team hears about it in the review channel...
    const notice = sends.find((entry) => entry.channelId === REVIEW_CHANNEL);
    assert.ok(notice, 'the review channel is told');
    assert.match(notice.payload.content, /Acme Plumbing.*replied/s);
    assert.match(notice.payload.content, /Friday works/);
    assert.deepEqual(notice.payload.allowedMentions, { parse: [] });

    // ...the review card is updated...
    assert.ok(edits.some((entry) => entry.messageId === 'review-1'));

    // ...and nothing is left waiting.
    assert.equal(store.findByChannel(CLIENT_CHANNEL).length, 0);
    assert.equal(store.awaitingAck(Date.now() + 86_400_000).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('silence past the follow-up window raises it once, not repeatedly', async () => {
  const { dir, store, record, client, sends } = await setup();
  try {
    const sent = await deliverDiscord(client, store, record, { id: 'staff-1' });
    await store.update(sent.id, { followupAt: new Date(Date.now() - 1000).toISOString() });

    assert.equal(await runFollowupSweep(client, store), 1);
    const nudge = sends.find((entry) => entry.channelId === REVIEW_CHANNEL);
    assert.ok(nudge, 'the team is nudged');
    assert.match(nudge.payload.content, /no reply on Discord/);
    assert.match(nudge.payload.content, /No sign they have seen their go-live notice/);

    // Second sweep must stay quiet.
    const before = sends.length;
    assert.equal(await runFollowupSweep(client, store), 0);
    assert.equal(sends.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a review message that was deleted does not take the bot down', async () => {
  const { dir, store, record } = await setup();
  try {
    const client = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: { fetch: async () => { throw new Error('Unknown Message'); } },
        }),
      },
    };
    await refreshReviewMessage(client, record); // resolves rather than throwing
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
