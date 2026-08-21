import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { renderTemplate } from './template.js';
import {
  formatLong,
  formatShort,
  isWeekend,
  parseGoLive,
  relativeLabel,
  todayInZone,
  weekdayName,
} from './dates.js';

const MESSAGES_PATH = new URL('../config/messages.json', import.meta.url);

/** Re-read on every draft so copy edits take effect without a restart. */
export async function loadMessages(path = MESSAGES_PATH) {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  for (const key of ['discord', 'sms', 'smsNudge']) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      throw new Error(`config/messages.json is missing the "${key}" template.`);
    }
  }
  return parsed;
}

/**
 * Trello holds phone numbers however whoever typed them felt that day.
 * Returns E.164 or null when we cannot be confident.
 */
export function normalizePhone(input, countryCode = config.defaultCountryCode) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = raw.replace(/\D/g, '');
  const cc = String(countryCode || '+1').replace(/\D/g, '') || '1';
  if (cc === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  }
  if (digits.length >= 8 && digits.length <= 15) return `+${cc}${digits.replace(/^0+/, '')}`;
  return null;
}

/** Discord IDs are 17-20 digit snowflakes; strip <@...> / <#...> wrappers. */
export function normalizeSnowflake(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const unwrapped = raw.replace(/^<[@#]?[!&]?/, '').replace(/>$/, '');
  const digits = unwrapped.replace(/\D/g, '');
  return /^\d{17,20}$/.test(digits) ? digits : null;
}

function looksLikeSheet(url) {
  return /^https:\/\/docs\.google\.com\/spreadsheets\//i.test(String(url || '').trim());
}

export const SOURCE_LABELS = {
  command: 'the command',
  field: 'a Trello field',
  update: 'the update comment',
  card: 'the card itself',
};

/**
 * Decide where each value comes from, and remember which source won.
 *
 * A Trello custom field is somebody deliberately writing the value in a named
 * box, so it beats the same value inferred from prose. The update comment is
 * what the systems person actually writes today, so it is what makes the bot
 * work on a board with no custom fields at all.
 */
export function resolveValues(card, { dateOverride = '', channelOverride = '' } = {}) {
  const fields = card.fields || {};
  const update = card.update || null;
  const parsed = update?.values || {};
  const values = {};
  const sources = {};

  const pick = (key, candidates) => {
    for (const [source, value] of candidates) {
      const clean = typeof value === 'string' ? value.trim() : value;
      if (clean) {
        values[key] = clean;
        sources[key] = source;
        return;
      }
    }
  };

  pick('goLiveDate', [
    ['command', dateOverride],
    ['field', fields.goLiveDate],
    ['update', parsed.goLiveDate],
    ['card', card.due],
  ]);
  pick('channelId', [
    ['command', channelOverride],
    ['field', fields.discordChannelId],
    ['update', parsed.channelId],
  ]);
  pick('channelName', [['update', parsed.channelName]]);
  pick('sheetUrl', [
    ['field', fields.sheetUrl],
    ['update', parsed.sheetUrl],
  ]);
  pick('clientName', [
    ['field', fields.clientName],
    ['update', parsed.clientName],
    ['card', card.name],
  ]);
  pick('agentPhone', [
    ['field', fields.agentPhone],
    ['update', parsed.agentPhone],
  ]);
  pick('agentDiscordId', [['field', fields.agentDiscordId]]);
  pick('agentName', [['field', fields.agentName]]);
  pick('campaignName', [['field', fields.campaignName]]);
  pick('goLiveTime', [['field', fields.goLiveTime]]);
  pick('timezoneLabel', [['field', fields.timezoneLabel]]);
  pick('hubUrl', [['field', fields.hubUrl]]);

  return { values, sources, update };
}

/**
 * Turn a Trello card into a ready-to-review draft.
 * Never throws on bad card data: problems are collected so the review card can
 * say exactly what to fix, rather than failing with a stack trace.
 */
export async function buildDraft({
  card,
  dateOverride = '',
  channelOverride = '',
  timezone = config.defaultTimezone,
  now = new Date(),
  messages,
  resolveChannel,
}) {
  const copy = messages || (await loadMessages());
  const { values, sources, update } = resolveValues(card, { dateOverride, channelOverride });
  const problems = [];
  const warnings = [];

  const clientName = values.clientName || '';
  const campaignName = values.campaignName || '';
  const agentName = values.agentName || '';
  const sheetUrl = values.sheetUrl || '';
  const hubUrl = values.hubUrl || '';
  const goLiveTime = values.goLiveTime || '';
  const timezoneLabel = values.timezoneLabel || '';

  const agentDiscordId = normalizeSnowflake(values.agentDiscordId);
  const phone = normalizePhone(values.agentPhone);

  // --- where to post -------------------------------------------------------
  // A channel written as "#jando-setup" only becomes an ID once we can ask
  // Discord. Without a resolver (the check-card CLI) the answer is unknown
  // rather than no, and unknown must not read as a failure.
  const canResolveChannels = typeof resolveChannel === 'function';
  let channelId = normalizeSnowflake(values.channelId);
  const channelName = values.channelName || '';
  if (!channelId && channelName && canResolveChannels) {
    const resolved = await resolveChannel(channelName).catch(() => null);
    if (resolved) {
      channelId = resolved;
      sources.channelId = sources.channelName || 'update';
    }
  }
  const channelUnresolved = Boolean(channelName) && !channelId;
  if (channelUnresolved && canResolveChannels) {
    warnings.push(
      `The update names #${channelName}, but no channel by that name is visible to the bot. Check the name, or pass \`channel:\` on the command.`,
    );
  }

  // --- go-live date --------------------------------------------------------
  const today = todayInZone(timezone, now);
  let goLiveDate = null;
  const rawDate = values.goLiveDate || '';
  if (!rawDate) {
    problems.push(
      'No go-live date. Say "ready to go live on <date>" in the Trello update, set a "Go Live Date" field, or pass `date:` on the command.',
    );
  } else {
    try {
      goLiveDate = parseGoLive(rawDate, { timezone, now });
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (goLiveDate) {
    if (sources.goLiveDate === 'update' && update && !update.goLiveDateConfident) {
      warnings.push(
        `The update never says "go live on …", so ${formatLong(goLiveDate)} was read from a date found in the text. Worth a check.`,
      );
    }
    if (goLiveDate < today) {
      warnings.push(
        `The go-live date is in the past (${relativeLabel(goLiveDate, today)}). Double-check before sending.`,
      );
    } else if (goLiveDate === today) {
      warnings.push('Go-live is today — make sure that is right.');
    }
    if (isWeekend(goLiveDate)) {
      warnings.push(`${weekdayName(goLiveDate)} is a weekend — confirm that is intended.`);
    }
  }

  // --- sheet ---------------------------------------------------------------
  if (!sheetUrl) {
    problems.push('No Google Sheet link — none in the Trello update, and no "Google Sheet" field.');
  } else if (!looksLikeSheet(sheetUrl)) {
    warnings.push('The sheet link is not a docs.google.com/spreadsheets URL — check it points where you expect.');
  }

  // --- delivery routes -----------------------------------------------------
  if (!channelId && !channelName) {
    warnings.push(
      'No Discord channel on the card, so Discord delivery is unavailable. Ask for the channel in the update, or pass `channel:` on the command.',
    );
  }
  if (!phone && config.ringcentral.enabled) {
    if (values.agentPhone) {
      warnings.push(`Could not read "${values.agentPhone}" as a phone number, so SMS is unavailable.`);
    } else {
      warnings.push('No phone number for this client, so the SMS fallback is unavailable.');
    }
  }
  // Unknown-but-named channels are excluded: only claim there is no way to
  // reach the client when we have actually looked.
  if (!channelId && !phone && !(channelUnresolved && !canResolveChannels)) {
    problems.push(
      'No way to reach this client: no Discord channel the bot can see, and no usable phone number.',
    );
  }
  if (!update && !Object.keys(card.fields || {}).length) {
    warnings.push(
      'No setup-complete update was found on this card, and it has no custom fields — everything below came from the card itself.',
    );
  }

  // --- copy ----------------------------------------------------------------
  const shared = {
    clientName,
    agentName,
    teamName: config.teamName,
    goLiveLong: goLiveDate ? formatLong(goLiveDate) : '',
    goLiveShort: goLiveDate ? formatShort(goLiveDate) : '',
    goLiveWeekday: goLiveDate ? weekdayName(goLiveDate) : '',
    // "which is tomorrow" — the way the team says it out loud.
    goLiveRelative: goLiveDate ? relativeLabel(goLiveDate, today) : '',
    goLiveTime,
    timezoneLabel,
    sheetUrl,
    hubUrl,
  };

  const discordBody = renderTemplate(copy.discord, {
    ...shared,
    agentMention: agentDiscordId ? `<@${agentDiscordId}>` : agentName || 'there',
    campaignLabel: campaignName ? `**${campaignName}** setup` : 'setup',
  });

  const smsValues = {
    ...shared,
    agentMention: agentName || 'there',
    campaignLabel: campaignName ? `${campaignName} setup` : 'setup',
  };
  const smsBody = renderTemplate(copy.sms, smsValues);
  const smsNudgeBody = renderTemplate(copy.smsNudge, smsValues);

  // Discord hard-rejects anything longer; better to catch it in review.
  if (discordBody.length > 2000) {
    problems.push(
      `The message is ${discordBody.length} characters — Discord's limit is 2000. Shorten the copy in config/messages.json.`,
    );
  }

  return {
    cardId: card.id,
    cardUrl: card.url,
    cardName: card.name,
    listName: card.listName || '',
    clientName,
    campaignName,
    agentName,
    agentDiscordId,
    phone,
    channelId,
    channelName,
    channelResolved: canResolveChannels,
    sheetUrl,
    hubUrl,
    goLiveDate,
    goLiveTime,
    timezoneLabel,
    rawDate,
    sources,
    update: update
      ? {
          text: update.anchor.text,
          author: update.anchor.author,
          date: update.anchor.date,
        }
      : null,
    timezone,
    discordBody,
    smsBody,
    smsNudgeBody,
    problems,
    warnings,
    canSendDiscord: problems.length === 0 && Boolean(channelId),
    canSendSms: problems.length === 0 && Boolean(phone) && config.ringcentral.enabled,
  };
}
