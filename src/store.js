import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A JSON file is the right size of tool here: a handful of notifications a day,
 * and being able to open the file and read what was sent to whom is a feature.
 * All writes are atomic (tmp + rename) so a crash mid-send cannot shred it.
 */
export class Store {
  constructor(path) {
    this.path = path;
    this.state = { version: 1, records: {} };
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.records) this.state = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dirname(this.path), { recursive: true });
      await this.flush();
    }
    return this;
  }

  /** Serialised so concurrent button clicks cannot interleave writes. */
  flush() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.state, null, 2));
      await rename(tmp, this.path);
    });
    return this.queue;
  }

  async create(record) {
    const id = randomUUID().slice(0, 8);
    const stored = {
      id,
      status: 'pending',
      createdAt: new Date().toISOString(),
      discord: { sent: false },
      sms: { sent: false },
      ack: null,
      followupDone: false,
      ...record,
    };
    this.state.records[id] = stored;
    await this.flush();
    return stored;
  }

  get(id) {
    return this.state.records[id] || null;
  }

  async update(id, patch) {
    const existing = this.state.records[id];
    if (!existing) return null;
    const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.state.records[id] = merged;
    await this.flush();
    return merged;
  }

  all() {
    return Object.values(this.state.records);
  }

  /** Sent on Discord, no reply yet, follow-up nudge not yet raised. */
  awaitingAck(now = Date.now()) {
    return this.all().filter(
      (record) =>
        record.status === 'sent' &&
        record.discord?.sent &&
        !record.ack &&
        !record.followupDone &&
        record.followupAt &&
        Date.parse(record.followupAt) <= now,
    );
  }

  /** Records whose client channel we watch for a reply. */
  findByChannel(channelId) {
    return this.all().filter(
      (record) => record.status === 'sent' && record.discord?.channelId === channelId && !record.ack,
    );
  }
}
