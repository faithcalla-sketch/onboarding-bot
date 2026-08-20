import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'onboarding-store-'));
  const store = await new Store(join(dir, 'state.json')).load();
  return { store, dir };
}

test('records survive a restart', async () => {
  const { store, dir } = await freshStore();
  try {
    const created = await store.create({ draft: { clientName: 'Acme' } });
    const reopened = await new Store(store.path).load();
    assert.equal(reopened.get(created.id).draft.clientName, 'Acme');
    assert.equal(reopened.get(created.id).status, 'pending');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the state file stays valid JSON under concurrent writes', async () => {
  const { store, dir } = await freshStore();
  try {
    const records = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.create({ draft: { clientName: `Client ${index}` } })),
    );
    await Promise.all(records.map((record) => store.update(record.id, { status: 'sent' })));
    await store.flush();
    const parsed = JSON.parse(await readFile(store.path, 'utf8'));
    assert.equal(Object.keys(parsed.records).length, 10);
    assert.ok(records.every((record) => parsed.records[record.id].status === 'sent'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('follow-ups come due only for sent, unanswered, un-nudged records', async () => {
  const { store, dir } = await freshStore();
  try {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();

    const due = await store.create({ draft: {} });
    await store.update(due.id, { status: 'sent', discord: { sent: true }, followupAt: past });

    const notYet = await store.create({ draft: {} });
    await store.update(notYet.id, { status: 'sent', discord: { sent: true }, followupAt: future });

    const answered = await store.create({ draft: {} });
    await store.update(answered.id, {
      status: 'sent',
      discord: { sent: true },
      followupAt: past,
      ack: { at: past },
    });

    const alreadyNudged = await store.create({ draft: {} });
    await store.update(alreadyNudged.id, {
      status: 'sent',
      discord: { sent: true },
      followupAt: past,
      followupDone: true,
    });

    const stillPending = await store.create({ draft: {} });
    await store.update(stillPending.id, { followupAt: past });

    const ids = store.awaitingAck().map((record) => record.id);
    assert.deepEqual(ids, [due.id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('channel lookup finds only sent, unanswered records for that channel', async () => {
  const { store, dir } = await freshStore();
  try {
    const watched = await store.create({ draft: {} });
    await store.update(watched.id, { status: 'sent', discord: { sent: true, channelId: 'chan-1' } });

    const answered = await store.create({ draft: {} });
    await store.update(answered.id, {
      status: 'sent',
      discord: { sent: true, channelId: 'chan-1' },
      ack: { at: new Date().toISOString() },
    });

    const other = await store.create({ draft: {} });
    await store.update(other.id, { status: 'sent', discord: { sent: true, channelId: 'chan-2' } });

    assert.deepEqual(store.findByChannel('chan-1').map((r) => r.id), [watched.id]);
    assert.deepEqual(store.findByChannel('chan-2').map((r) => r.id), [other.id]);
    assert.deepEqual(store.findByChannel('chan-3'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updating a record that does not exist is a no-op, not a crash', async () => {
  const { store, dir } = await freshStore();
  try {
    assert.equal(await store.update('nope', { status: 'sent' }), null);
    assert.equal(store.get('nope'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
