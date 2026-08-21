import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { extractFromComments } from './parse-update.js';

// Overridable so the whole fetch path can be exercised against a stub server.
const API = process.env.TRELLO_API_BASE || 'https://api.trello.com/1';

let fieldMapPromise = null;

/** Field-name matching is forgiving: case, spaces, dashes and underscores. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export async function loadFieldMap(path = new URL('../config/fields.json', import.meta.url)) {
  if (!fieldMapPromise) {
    fieldMapPromise = readFile(path, 'utf8').then((raw) => {
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const [key, names] of Object.entries(parsed)) {
        if (key.startsWith('_') || !Array.isArray(names)) continue;
        for (const name of names) map.set(normalizeName(name), key);
      }
      return map;
    });
  }
  return fieldMapPromise;
}

/**
 * Accepts a full card URL, a short link, or a raw card id.
 * https://trello.com/c/AbCd1234/57-acme-setup -> AbCd1234
 */
export function parseCardRef(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('No Trello card given.');
  const urlMatch = /trello\.com\/c\/([a-zA-Z0-9]+)/.exec(raw);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9]{8,24}$/.test(raw)) return raw;
  throw new Error(
    `"${raw}" does not look like a Trello card. Paste the card URL (https://trello.com/c/...) or its short link.`,
  );
}

async function trelloFetch(path, params = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('key', config.trello.key);
  url.searchParams.set('token', config.trello.token);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Trello rejected the request (${response.status}). Check TRELLO_KEY/TRELLO_TOKEN and that the token can read this board.`,
      );
    }
    if (response.status === 404) {
      throw new Error('Trello card not found. Check the link, and that the bot token can see that board.');
    }
    throw new Error(`Trello API error ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

/** Turn one card custom-field item into a plain string. */
export function readFieldValue(item, definition) {
  if (!item) return '';
  if (item.idValue) {
    const option = (definition?.options || []).find((opt) => opt.id === item.idValue);
    return option?.value?.text ? String(option.value.text) : '';
  }
  const value = item.value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.number === 'string' || typeof value.number === 'number') {
    return String(value.number);
  }
  if (typeof value.date === 'string') return value.date;
  if (typeof value.checked === 'string') return value.checked;
  return '';
}

/**
 * Reduce a card's custom fields to the logical keys in config/fields.json.
 * Unmapped fields are kept under `extra` so nothing is silently lost.
 */
export function mapCustomFields(definitions, items, fieldMap) {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const fields = {};
  const extra = {};
  const unmatched = [];

  for (const item of items || []) {
    const definition = byId.get(item.idCustomField);
    if (!definition) continue;
    const value = readFieldValue(item, definition);
    if (!value) continue;
    const key = fieldMap.get(normalizeName(definition.name));
    if (key) {
      if (!fields[key]) fields[key] = value;
    } else {
      extra[definition.name] = value;
    }
  }

  for (const definition of definitions) {
    if (!fieldMap.has(normalizeName(definition.name))) unmatched.push(definition.name);
  }

  return { fields, extra, unmatched };
}

/** The card's comment history, newest first. */
export async function loadComments(cardId, limit = 25) {
  const actions = await trelloFetch(`/cards/${cardId}/actions`, {
    filter: 'commentCard',
    limit: Math.min(limit, 50),
  });
  return (actions || []).map((action) => ({
    id: action.id,
    text: action.data?.text || '',
    date: action.date || '',
    author: action.memberCreator?.fullName || action.memberCreator?.username || '',
  }));
}

/**
 * Everything we know about a card, ready for message building.
 *
 * Both sources are read: the custom fields, and the systems person's
 * setup-complete comment. The comment is what she actually writes today, so
 * the bot has to understand it; the fields, where a board has them, are the
 * explicit version and win on any disagreement.
 */
export async function loadCard(cardRef) {
  const id = parseCardRef(cardRef);
  const card = await trelloFetch(`/cards/${id}`, {
    fields: 'name,desc,shortUrl,url,due,idBoard,idList,dateLastActivity',
    customFieldItems: 'true',
    list: 'true',
    members: 'true',
    member_fields: 'fullName,username',
  });

  const [definitions, comments] = await Promise.all([
    trelloFetch(`/boards/${card.idBoard}/customFields`).catch(() => []),
    loadComments(card.id).catch(() => []),
  ]);

  const fieldMap = await loadFieldMap();
  const { fields, extra, unmatched } = mapCustomFields(
    definitions,
    card.customFieldItems,
    fieldMap,
  );

  return {
    id: card.id,
    name: card.name,
    description: card.desc || '',
    url: card.shortUrl || card.url,
    listName: card.list?.name || '',
    due: card.due || '',
    members: (card.members || []).map((member) => member.fullName || member.username),
    fields,
    extra,
    unmatchedFieldNames: unmatched,
    comments,
    update: extractFromComments(comments),
  };
}

/** Exported for tests. */
export const _internals = { normalizeName };
