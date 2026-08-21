import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from '../config.js';
import { sendSms } from '../services/ringcentral.js';
import { ACTIONS, buildCustomId, buildReviewPayload } from './review.js';

async function fetchSendableChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error(
      `Cannot see channel <#${channelId}>. Check the ID on the Trello card and that the bot has been added to that channel.`,
    );
  }
  if (!channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`<#${channelId}> is not a channel the bot can post in.`);
  }
  return channel;
}

/** Post the client-facing message in their setup channel. */
export async function deliverDiscord(client, store, record, actor) {
  const { draft } = record;
  if (record.discord?.sent) throw new Error('This one has already been sent on Discord.');
  if (draft.problems.length) throw new Error('Fix the problems on the Trello card first.');
  if (!draft.channelId) throw new Error('No Discord channel to send to.');

  let sent;
  if (config.dryRun) {
    console.log(`[dry-run] Discord message to #${draft.channelId}:\n${draft.discordBody}`);
    sent = { id: 'dry-run', url: null };
  } else {
    const channel = await fetchSendableChannel(client, draft.channelId);
    sent = await channel.send({
      content: draft.discordBody,
      // Only the agent gets pinged: never @everyone, never a stray role.
      allowedMentions: draft.agentDiscordId
        ? { parse: [], users: [draft.agentDiscordId] }
        : { parse: [] },
    });
  }

  const now = new Date();
  return store.update(record.id, {
    status: 'sent',
    discord: {
      sent: true,
      channelId: draft.channelId,
      messageId: sent.id,
      messageUrl: sent.url || null,
      at: now.toISOString(),
      by: actor?.id || null,
    },
    followupAt: new Date(now.getTime() + config.followupHours * 3600_000).toISOString(),
  });
}

/** Text the agent through RingCentral — the fallback when Discord goes unread. */
export async function deliverSms(store, record, actor, { nudge = false } = {}) {
  const { draft } = record;
  if (!draft.phone) throw new Error('No usable phone number on the Trello card.');
  if (!nudge && record.sms?.sent) throw new Error('An SMS has already gone out for this one.');
  if (draft.problems.length) throw new Error('Fix the problems on the Trello card first.');

  const text = nudge ? draft.smsNudgeBody : draft.smsBody;
  const result = await sendSms({ to: draft.phone, text });
  const now = new Date();

  return store.update(record.id, {
    status: 'sent',
    sms: {
      sent: true,
      to: draft.phone,
      at: now.toISOString(),
      by: actor?.id || null,
      messageId: result.id,
      nudge,
    },
    followupAt:
      record.followupAt ||
      new Date(now.getTime() + config.followupHours * 3600_000).toISOString(),
  });
}

/** Keep the review card in sync with what has actually happened. */
export async function refreshReviewMessage(client, record) {
  if (!record.reviewChannelId || !record.reviewMessageId) return;
  const channel = await client.channels.fetch(record.reviewChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(record.reviewMessageId).catch(() => null);
  if (!message) return;
  await message.edit(buildReviewPayload(record)).catch((error) => {
    console.error(`Could not update review message for draft ${record.id}:`, error.message);
  });
}

/**
 * The client answered in their channel. Nothing was being asked of them, so a
 * reply is not an approval - it is proof the notice landed, and sometimes a
 * change of plan. Either way: stop chasing, and put it in front of the team.
 */
export async function recordAck(client, store, record, message) {
  const updated = await store.update(record.id, {
    ack: {
      at: new Date().toISOString(),
      by: message.author.id,
      byTag: message.author.tag ?? message.author.username,
      via: 'discord',
      excerpt: String(message.content || '').slice(0, 300),
      messageUrl: message.url || null,
    },
    followupDone: true,
  });

  await refreshReviewMessage(client, updated);

  const channel = await client.channels
    .fetch(record.reviewChannelId)
    .catch(() => null);
  if (channel?.isTextBased()) {
    const excerpt = updated.ack.excerpt ? `\n> ${updated.ack.excerpt.replace(/\n/g, '\n> ')}` : '';
    await channel
      .send({
        content: `🎉 **${updated.draft.clientName || updated.draft.cardName}** replied in <#${message.channelId}>${excerpt}`,
        allowedMentions: { parse: [] },
        reply: updated.reviewMessageId
          ? { messageReference: updated.reviewMessageId, failIfNotExists: false }
          : undefined,
      })
      .catch(() => {});
  }
  return updated;
}

/**
 * Nobody replied within FOLLOWUP_HOURS. This is exactly the moment the job used
 * to be "go check Discord, then go text them" — so raise it once, with the
 * text-them button already loaded.
 */
export async function runFollowupSweep(client, store) {
  const due = store.awaitingAck();
  for (const record of due) {
    await store.update(record.id, { followupDone: true });
    const channel = await client.channels.fetch(record.reviewChannelId).catch(() => null);
    if (!channel?.isTextBased()) continue;

    const canText = Boolean(record.draft.phone) && config.ringcentral.enabled && !record.sms?.sent;
    const row = new ActionRowBuilder();
    if (canText) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId(ACTIONS.NUDGE_SMS, record.id))
          .setLabel('Text them a nudge')
          .setEmoji('📱')
          .setStyle(ButtonStyle.Primary),
      );
    }
    if (record.discord?.messageUrl) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('Open the thread')
          .setStyle(ButtonStyle.Link)
          .setURL(record.discord.messageUrl),
      );
    }

    const who = record.draft.clientName || record.draft.agentName || record.draft.cardName;
    const reason = record.sms?.sent
      ? 'no reply on Discord or to the text'
      : canText
        ? 'no reply on Discord — they may not be in the channel'
        : 'no reply on Discord, and there is no usable number to text';

    await channel
      .send({
        content: `⏳ **${who}** — ${reason} (${config.followupHours}h since we posted it). No sign they have seen their go-live notice.`,
        components: row.components.length ? [row] : [],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return due.length;
}
