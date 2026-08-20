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

/**
 * Turn a Trello card into a ready-to-review draft.
 * Never throws on bad card data: problems are collected so the review embed can
 * explain exactly which Trello field needs fixing.
 */
export async function buildDraft({
  card,
  dateOverride = '',
  channelOverride = '',
  timezone = config.defaultTimezone,
  now = new Date(),
  messages,
}) {
  const copy = messages || (await loadMessages());
  const fields = card.fields || {};
  const problems = [];
  const warnings = [];

  const clientName = (fields.clientName || card.name || '').trim();
  const campaignName = (fields.campaignName || '').trim();
  const agentName = (fields.agentName || '').trim();
  const sheetUrl = (fields.sheetUrl || '').trim();
  const hubUrl = (fields.hubUrl || '').trim();
  const goLiveTime = (fields.goLiveTime || '').trim();
  const timezoneLabel = (fields.timezoneLabel || '').trim();

  const channelId =
    normalizeSnowflake(channelOverride) || normalizeSnowflake(fields.discordChannelId);
  const agentDiscordId = normalizeSnowflake(fields.agentDiscordId);
  const phone = normalizePhone(fields.agentPhone);

  // --- go-live date -------------------------------------------------------
  const today = todayInZone(timezone, now);
  let goLiveDate = null;
  const dateSource = dateOverride ? 'command' : fields.goLiveDate ? 'card' : card.due ? 'due' : null;
  const rawDate = dateOverride || fields.goLiveDate || card.due || '';
  if (!rawDate) {
    problems.push(
      'No go-live date. Set the "Go Live Date" field on the Trello card, or pass `date:` on the command.',
    );
  } else {
    try {
      goLiveDate = parseGoLive(rawDate, { timezone, now });
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (goLiveDate) {
    const delta = relativeLabel(goLiveDate, today);
    if (goLiveDate < today) {
      warnings.push(`Go-live date is in the past (${delta}). Double-check before sending.`);
    } else if (goLiveDate === today) {
      warnings.push('Go-live is today — make sure the client has enough notice.');
    }
    if (isWeekend(goLiveDate)) {
      warnings.push(`${weekdayName(goLiveDate)} is a weekend — confirm that is intended.`);
    }
  }

  // --- sheet --------------------------------------------------------------
  if (!sheetUrl) {
    problems.push('No Google Sheet link. Set the "Google Sheet" field on the Trello card.');
  } else if (!looksLikeSheet(sheetUrl)) {
    warnings.push('The sheet link is not a docs.google.com/spreadsheets URL — check it points where you expect.');
  }

  // --- delivery routes ----------------------------------------------------
  if (!channelId) {
    warnings.push(
      'No Discord channel on the card, so Discord delivery is unavailable. Set "Discord Channel ID", or pass `channel:` on the command.',
    );
  }
  if (!phone) {
    if (fields.agentPhone) {
      warnings.push(`Could not read "${fields.agentPhone}" as a phone number, so SMS is unavailable.`);
    } else {
      warnings.push('No phone number on the card, so the SMS fallback is unavailable.');
    }
  }
  if (!channelId && !phone) {
    problems.push('No way to reach this client: the card has neither a Discord channel nor a usable phone number.');
  }
  if (!agentDiscordId && channelId) {
    warnings.push('No agent Discord ID, so the message will not @mention anyone in the channel.');
  }

  // --- copy ---------------------------------------------------------------
  const shared = {
    clientName,
    agentName,
    teamName: config.teamName,
    goLiveLong: goLiveDate ? formatLong(goLiveDate) : '',
    goLiveShort: goLiveDate ? formatShort(goLiveDate) : '',
    goLiveWeekday: goLiveDate ? weekdayName(goLiveDate) : '',
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
    sheetUrl,
    hubUrl,
    goLiveDate,
    goLiveTime,
    timezoneLabel,
    dateSource,
    rawDate,
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
