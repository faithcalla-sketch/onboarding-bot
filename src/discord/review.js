import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { formatLong, relativeLabel, todayInZone } from '../dates.js';
import { estimateSegments } from '../services/ringcentral.js';
import { config } from '../config.js';

export const ACTIONS = {
  SEND_DISCORD: 'send_discord',
  SEND_SMS: 'send_sms',
  EDIT: 'edit',
  DISCARD: 'discard',
  NUDGE_SMS: 'nudge_sms',
};

const PREFIX = 'nb';

export function buildCustomId(action, recordId) {
  return `${PREFIX}:${action}:${recordId}`;
}

export function parseCustomId(customId) {
  const [prefix, action, recordId] = String(customId || '').split(':');
  if (prefix !== PREFIX || !action || !recordId) return null;
  return { action, recordId };
}

const COLORS = {
  blocked: 0xd94f4f,
  warning: 0xe0a800,
  ready: 0x3aa76d,
  sent: 0x5865f2,
  acked: 0x2f9e6e,
};

function truncate(text, max) {
  const body = String(text ?? '');
  return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
}

function goLiveLine(record) {
  const { draft } = record;
  if (!draft.goLiveDate) return '⛔ not set';
  const today = todayInZone(draft.timezone || config.defaultTimezone);
  const parts = [`**${formatLong(draft.goLiveDate)}**`, `(${relativeLabel(draft.goLiveDate, today)})`];
  if (draft.goLiveTime) parts.splice(1, 0, `at ${draft.goLiveTime}`);
  if (draft.timezoneLabel) parts.splice(draft.goLiveTime ? 2 : 1, 0, draft.timezoneLabel);
  return parts.join(' ');
}

function deliveryLine(record) {
  const { draft } = record;
  const lines = [];
  if (draft.channelId) {
    const mention = draft.agentDiscordId ? ` — mentions <@${draft.agentDiscordId}>` : ' — no @mention';
    lines.push(`💬 <#${draft.channelId}>${mention}`);
  } else {
    lines.push('💬 no Discord channel on the card');
  }
  if (draft.phone) {
    lines.push(
      config.ringcentral.enabled
        ? `📱 ${draft.phone} (${estimateSegments(draft.smsBody)} SMS segment${estimateSegments(draft.smsBody) === 1 ? '' : 's'})`
        : `📱 ${draft.phone} — RingCentral not configured`,
    );
  } else {
    lines.push('📱 no usable phone number');
  }
  return lines.join('\n');
}

function statusLine(record) {
  const bits = [];
  if (record.discord?.sent) {
    const link = record.discord.messageUrl ? `[message](${record.discord.messageUrl})` : 'message';
    bits.push(`✅ Discord ${link} sent <t:${Math.floor(Date.parse(record.discord.at) / 1000)}:R>`);
  }
  if (record.sms?.sent) {
    bits.push(`✅ SMS sent to ${record.sms.to} <t:${Math.floor(Date.parse(record.sms.at) / 1000)}:R>`);
  }
  if (record.ack) {
    bits.push(`🎉 Client replied <t:${Math.floor(Date.parse(record.ack.at) / 1000)}:R>`);
  } else if (record.discord?.sent || record.sms?.sent) {
    bits.push('⏳ waiting on the client to confirm the date');
  }
  if (record.status === 'cancelled') bits.push('🗑 discarded');
  return bits.join('\n');
}

export function buildReviewEmbed(record) {
  const { draft } = record;
  const blocked = draft.problems.length > 0;
  const sent = record.discord?.sent || record.sms?.sent;

  const color = record.ack
    ? COLORS.acked
    : sent
      ? COLORS.sent
      : blocked
        ? COLORS.blocked
        : draft.warnings.length
          ? COLORS.warning
          : COLORS.ready;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${draft.clientName || draft.cardName || 'Client'} — ready to go live`)
    .setURL(draft.cardUrl || null)
    .setDescription(truncate(draft.discordBody, 2000))
    .addFields(
      { name: 'Go live', value: goLiveLine(record), inline: false },
      { name: 'Deliver to', value: deliveryLine(record), inline: false },
    )
    .setFooter({ text: `draft ${record.id}${draft.listName ? ` · ${draft.listName}` : ''}` })
    .setTimestamp(Date.parse(record.createdAt) || Date.now());

  if (draft.campaignName) {
    embed.addFields({ name: 'Campaign', value: draft.campaignName, inline: true });
  }
  if (draft.sheetUrl) {
    embed.addFields({ name: 'Sheet', value: `[open](${draft.sheetUrl})`, inline: true });
  }
  if (draft.hubUrl) {
    embed.addFields({ name: 'Hub', value: `[open](${draft.hubUrl})`, inline: true });
  }
  if (draft.problems.length) {
    embed.addFields({
      name: '⛔ Fix on the Trello card before sending',
      value: truncate(draft.problems.map((item) => `• ${item}`).join('\n'), 1024),
    });
  }
  if (draft.warnings.length) {
    embed.addFields({
      name: '⚠️ Worth a look',
      value: truncate(draft.warnings.map((item) => `• ${item}`).join('\n'), 1024),
    });
  }
  const status = statusLine(record);
  if (status) embed.addFields({ name: 'Status', value: truncate(status, 1024) });
  if (config.dryRun) {
    embed.addFields({ name: 'Mode', value: '🧪 DRY_RUN — nothing is actually delivered' });
  }

  return embed;
}

export function buildReviewComponents(record) {
  const { draft } = record;
  const rows = [];
  const primary = new ActionRowBuilder();

  if (record.status === 'cancelled') return rows;

  if (!record.discord?.sent) {
    primary.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId(ACTIONS.SEND_DISCORD, record.id))
        .setLabel('Approve & send on Discord')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!draft.canSendDiscord),
    );
  }

  if (!record.sms?.sent) {
    primary.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId(ACTIONS.SEND_SMS, record.id))
        .setLabel(record.discord?.sent ? 'Text them too' : 'Send as SMS instead')
        .setEmoji('📱')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!draft.canSendSms),
    );
  }

  if (!record.discord?.sent && !record.sms?.sent) {
    primary.addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId(ACTIONS.EDIT, record.id))
        .setLabel('Edit')
        .setEmoji('✏️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId(ACTIONS.DISCARD, record.id))
        .setLabel('Discard')
        .setEmoji('🗑')
        .setStyle(ButtonStyle.Danger),
    );
  }

  if (primary.components.length) rows.push(primary);

  const links = new ActionRowBuilder();
  if (record.discord?.messageUrl) {
    links.addComponents(
      new ButtonBuilder()
        .setLabel('View sent message')
        .setStyle(ButtonStyle.Link)
        .setURL(record.discord.messageUrl),
    );
  }
  if (draft.cardUrl) {
    links.addComponents(
      new ButtonBuilder().setLabel('Trello card').setStyle(ButtonStyle.Link).setURL(draft.cardUrl),
    );
  }
  if (links.components.length) rows.push(links);

  return rows;
}

export function buildReviewPayload(record) {
  return {
    embeds: [buildReviewEmbed(record)],
    components: buildReviewComponents(record),
  };
}
