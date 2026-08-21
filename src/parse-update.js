/**
 * Reads the systems person's setup-complete update off a Trello card.
 *
 * She writes it as prose, roughly:
 *
 *   OTP FX on this show hub setup is complete for Jando
 *   Fire the test in the Discord channel and you will see to ensure it works
 *   Added email SMS notification
 *   Client is ready to go live on Friday, August 21
 *   https://docs.google.com/spreadsheets/d/.../edit
 *   #jando-setup
 *
 * The wording moves around, so nothing here depends on an exact format: it
 * looks for the few things the client actually needs (their name, the live
 * date, the sheet, the channel) and reports where each one came from, so a
 * human can check the reading before anything is sent.
 *
 * The internal checklist lines — firing the test, email/SMS notifications —
 * are only ever used as evidence that a comment IS a setup update. None of
 * that wording reaches a client.
 */

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAY = String.raw`(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)`;

/**
 * Signals that a comment is *the* setup-complete update rather than ordinary
 * card chatter. More hits, more confidence.
 */
const STRONG_ANCHORS = [
  /setup\s+(?:is\s+)?(?:now\s+)?complete/i,
  /hub\s+setup/i,
  /ready\s+to\s+go\s+live/i,
  /ready\s+for\s+(?:his|her|their|the)?\s*(?:start|launch|live|go[- ]?live)\s*date/i,
  /fire\s+the\s+test/i,
  /email\s*(?:\/|and|\+|,)?\s*sms\s+notification/i,
];

// Corroborating, but not enough on its own: she often posts the sheet link as
// its own follow-up comment, and that comment is not the update.
const WEAK_ANCHORS = [/https:\/\/docs\.google\.com\/spreadsheets\//i];

/** Whether this comment is the setup-complete update rather than a follow-up. */
export function isSetupUpdate(text) {
  const body = String(text || '');
  return STRONG_ANCHORS.some((pattern) => pattern.test(body));
}

/** How strongly this text reads as a setup-complete update. */
export function scoreUpdate(text) {
  const body = String(text || '');
  return [...STRONG_ANCHORS, ...WEAK_ANCHORS].reduce(
    (score, pattern) => (pattern.test(body) ? score + 1 : score),
    0,
  );
}

/**
 * Find the first date-shaped run of text. Ordered most specific first, so
 * "Friday, August 21" yields "August 21" rather than "Friday".
 */
export function findDateIn(text) {
  const body = String(text || '');
  const patterns = [
    new RegExp(String.raw`\b\d{4}-\d{2}-\d{2}\b`),
    new RegExp(String.raw`\b${MONTH}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b`, 'i'),
    new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}\.?(?:,?\s+\d{4})?\b`, 'i'),
    new RegExp(String.raw`\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b`),
    /\b(?:today|tomorrow|tmrw?)\b/i,
    new RegExp(String.raw`\b${WEEKDAY}\b`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (match) return match[0].trim();
  }
  return null;
}

/** Phrases that introduce the live date. Everything after them gets scanned. */
const DATE_LEADS = [
  /(?:ready\s+to\s+)?go(?:es)?\s+live\s*(?:on|at)?\s*(.*)/i,
  /ready\s+(?:to|for)\s+(?:launch|go[- ]?live)\s*(?:on)?\s*(.*)/i,
  /(?:go[- ]?live|launch|live|start)\s*date\s*(?:is|:|-|—)?\s*(.*)/i,
  /launch(?:ing|es)?\s+on\s+(.*)/i,
  /(?:live|launch)\s+(?:day|date)\s+(?:is|:)?\s*(.*)/i,
];

/**
 * @returns {{raw: string, confident: boolean}|null}
 * `confident` is false when the date was picked up from loose text rather than
 * after an explicit "go live on" — those get flagged for a second look.
 */
export function findGoLiveDate(text) {
  const body = String(text || '');
  for (const line of body.split(/\r?\n/)) {
    for (const lead of DATE_LEADS) {
      const match = lead.exec(line);
      if (!match) continue;
      const found = findDateIn(match[1] || '');
      if (found) return { raw: found, confident: true };
    }
  }
  // Nothing said "go live on …". A lone date in a setup update is probably it,
  // but the review card will ask someone to confirm.
  const loose = findDateIn(body.replace(/https?:\/\/\S+/g, ' '));
  return loose ? { raw: loose, confident: false } : null;
}

const CLIENT_LEADS = [
  /setup\s+(?:is\s+)?(?:now\s+)?complete(?:d)?\s+for\s+(.+)/i,
  /complete(?:d)?\s+for\s+(.+)/i,
  /(?:client|account|business)\s*(?:name)?\s*[:\-]\s*(.+)/i,
  /set\s*up\s+(?:is\s+)?done\s+for\s+(.+)/i,
];

/** Trim a captured name back to the name itself. */
function cleanName(raw) {
  return String(raw || '')
    .split(/[.;|]|\s+[-–—]\s+|\s*\(/)[0]
    .replace(/\s*,\s*$/, '')
    .replace(/['’]s$/i, '')
    .replace(/\s+(?:is|are|and)\s+.*$/i, '')
    .trim()
    .slice(0, 80);
}

export function findClientName(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const lead of CLIENT_LEADS) {
      const match = lead.exec(line);
      if (match) {
        const name = cleanName(match[1]);
        if (name && name.length > 1) return name;
      }
    }
  }
  return null;
}

export function findSheetUrl(text) {
  const match = /https:\/\/docs\.google\.com\/spreadsheets\/[^\s<>()\[\]"']+/i.exec(
    String(text || ''),
  );
  return match ? match[0].replace(/[.,;]+$/, '') : null;
}

/**
 * A Discord channel written any of the ways a person might write one.
 * @returns {{id: string}|{name: string}|null}
 */
export function findChannel(text) {
  const body = String(text || '');

  const link = /discord\.com\/channels\/\d+\/(\d{17,20})/.exec(body);
  if (link) return { id: link[1] };

  const mention = /<#(\d{17,20})>/.exec(body);
  if (mention) return { id: mention[1] };

  const labelled = /(?:discord\s*)?channel(?:\s*id)?\s*[:\-]?\s*(\d{17,20})/i.exec(body);
  if (labelled) return { id: labelled[1] };

  // A bare snowflake: nothing else in these updates is 17-20 digits long.
  const bare = /(?<!\d)(\d{17,20})(?!\d)/.exec(body);
  if (bare) return { id: bare[1] };

  // "#jando-setup" — resolved against the server by name at send time.
  // Skipped when it is really a "#1" style reference.
  const named = /(?:^|\s)#([a-z0-9][a-z0-9_-]{1,99})\b/i.exec(body);
  if (named && !/^\d+$/.test(named[1])) return { name: named[1].toLowerCase() };

  return null;
}

export function findPhone(text) {
  const match = /(?:phone|mobile|cell|sms|text)\s*(?:number|#)?\s*[:\-]?\s*(\+?[\d(][\d\s().+-]{6,})/i.exec(
    String(text || ''),
  );
  return match ? match[1].trim().replace(/[\s.-]+$/, '') : null;
}

/** Everything one comment has to offer. */
export function parseUpdate(text) {
  const date = findGoLiveDate(text);
  const channel = findChannel(text);
  return {
    score: scoreUpdate(text),
    clientName: findClientName(text),
    goLiveDate: date?.raw || null,
    goLiveDateConfident: date?.confident ?? false,
    sheetUrl: findSheetUrl(text),
    channelId: channel && 'id' in channel ? channel.id : null,
    channelName: channel && 'name' in channel ? channel.name : null,
    agentPhone: findPhone(text),
  };
}

const FIELDS = [
  'clientName',
  'goLiveDate',
  'sheetUrl',
  'channelId',
  'channelName',
  'agentPhone',
];

/**
 * Pull the update out of a card's comment history.
 *
 * The systems person often posts the parts in sequence — "setup is complete",
 * then the sheet link, then the channel — so the newest comment that reads as
 * a setup update anchors the read, and anything it is missing is looked for in
 * the comments around it. Every value remembers which comment it came from.
 *
 * @param {Array<{id: string, text: string, date: string, author?: string}>} comments
 */
export function extractFromComments(comments = []) {
  const usable = comments
    .filter((comment) => comment && String(comment.text || '').trim())
    .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));

  const anchorIndex = usable.findIndex((comment) => isSetupUpdate(comment.text));
  if (anchorIndex === -1) return null;

  const anchor = usable[anchorIndex];
  const newer = usable.slice(0, anchorIndex).reverse(); // oldest of the newer ones first
  const older = usable.slice(anchorIndex + 1, anchorIndex + 6);
  const searchOrder = [anchor, ...newer, ...older];

  const values = {};
  const sources = {};
  let confident = true;

  for (const comment of searchOrder) {
    const parsed = parseUpdate(comment.text);
    for (const field of FIELDS) {
      if (values[field] || !parsed[field]) continue;
      values[field] = parsed[field];
      sources[field] = comment.id;
      if (field === 'goLiveDate') confident = parsed.goLiveDateConfident;
    }
  }

  return {
    values,
    sources,
    goLiveDateConfident: confident,
    anchor: {
      id: anchor.id,
      text: anchor.text,
      date: anchor.date,
      author: anchor.author || '',
      score: scoreUpdate(anchor.text),
    },
  };
}
