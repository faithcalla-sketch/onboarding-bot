import {
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { config, isApprover } from '../config.js';
import { loadCard } from '../trello.js';
import { buildDraft } from '../message.js';
import { formatShort, relativeLabel, todayInZone } from '../dates.js';
import { buildReviewPayload } from './review.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Draft the go-live message for a finished Trello setup')
    .addStringOption((option) =>
      option
        .setName('card')
        .setDescription('Trello card URL or short link')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('date')
        .setDescription('Override the go-live date, e.g. tomorrow, Friday, 8/24, 2026-08-24'),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription("Override the client's Discord channel"),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('pending')
    .setDescription('Show clients who have not replied to their go-live notice')
    .toJSON(),
];

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

/**
 * The systems person writes the channel as "#jando-setup", not as an ID, so
 * turn a name into a channel. An ambiguous name resolves to nothing rather
 * than to a guess — posting a client's details in the wrong channel is worse
 * than not posting at all.
 */
function makeChannelResolver(client) {
  return async (name) => {
    const guild = await client.guilds.fetch(config.discord.guildId).catch(() => null);
    if (!guild) return null;
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;

    const wanted = String(name).toLowerCase();
    const textChannels = [...channels.values()].filter(
      (channel) => channel && typeof channel.name === 'string' && channel.isTextBased?.(),
    );

    const exact = textChannels.filter((channel) => channel.name.toLowerCase() === wanted);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null;

    const prefix = textChannels.filter((channel) => channel.name.toLowerCase().startsWith(wanted));
    if (prefix.length === 1) return prefix[0].id;

    const contains = textChannels.filter((channel) => channel.name.toLowerCase().includes(wanted));
    return contains.length === 1 ? contains[0].id : null;
  };
}

async function requireApprover(interaction) {
  if (isApprover(interaction.user.id)) return true;
  await interaction.reply({
    content: 'You are not on the approver list (`APPROVER_IDS`), so you cannot send client messages.',
    ...EPHEMERAL,
  });
  return false;
}

async function handleNotify(interaction, { store, client }) {
  if (!(await requireApprover(interaction))) return;
  await interaction.deferReply(EPHEMERAL);

  const cardRef = interaction.options.getString('card', true);
  const dateOverride = interaction.options.getString('date') || '';
  const channelOverride = interaction.options.getChannel('channel')?.id || '';

  let card;
  try {
    card = await loadCard(cardRef);
  } catch (error) {
    await interaction.editReply(`⛔ ${error.message}`);
    return;
  }

  const draft = await buildDraft({
    card,
    dateOverride,
    channelOverride,
    resolveChannel: makeChannelResolver(client),
  });

  const reviewChannel = await client.channels
    .fetch(config.discord.reviewChannelId)
    .catch(() => null);
  if (!reviewChannel?.isTextBased()) {
    await interaction.editReply(
      '⛔ I cannot post in the review channel. Check `REVIEW_CHANNEL_ID` and that the bot can see and post in it.',
    );
    return;
  }

  const record = await store.create({
    draft,
    // Kept so an edit can rebuild the draft from source rather than patch text.
    card,
    createdBy: interaction.user.id,
    reviewChannelId: reviewChannel.id,
  });

  const message = await reviewChannel.send(buildReviewPayload(record));
  const saved = await store.update(record.id, { reviewMessageId: message.id });

  const headline = draft.problems.length
    ? `⚠️ Draft \`${saved.id}\` needs a fix before it can go out`
    : `📝 Draft \`${saved.id}\` is ready for your approval`;
  await interaction.editReply(`${headline} — ${message.url}`);
}

async function handlePending(interaction, { store }) {
  await interaction.deferReply(EPHEMERAL);
  const today = todayInZone(config.defaultTimezone);

  const open = store
    .all()
    .filter((record) => record.status !== 'cancelled' && !record.ack)
    .sort((a, b) => String(a.draft.goLiveDate).localeCompare(String(b.draft.goLiveDate)));

  if (!open.length) {
    await interaction.editReply('✅ Nothing outstanding — every client has come back to us.');
    return;
  }

  const lines = open.map((record) => {
    const { draft } = record;
    const when = draft.goLiveDate
      ? `${formatShort(draft.goLiveDate)} (${relativeLabel(draft.goLiveDate, today)})`
      : 'no date';
    const routes = [];
    if (record.discord?.sent) routes.push('discord ✅');
    if (record.sms?.sent) routes.push('sms ✅');
    const state = routes.length ? routes.join(' + ') : 'not sent yet';
    const link = record.discord?.messageUrl || draft.cardUrl || '';
    return `• **${draft.clientName || draft.cardName}** — ${when} — ${state}${link ? ` — ${link}` : ''}`;
  });

  const body = lines.join('\n');
  await interaction.editReply(
    `**${open.length} go-live notice${open.length === 1 ? '' : 's'} with no reply yet**\n${body.slice(0, 3800)}`,
  );
}

export async function handleCommand(interaction, context) {
  switch (interaction.commandName) {
    case 'notify':
      return handleNotify(interaction, context);
    case 'pending':
      return handlePending(interaction, context);
    default:
      return interaction.reply({ content: `Unknown command \`${interaction.commandName}\`.`, ...EPHEMERAL });
  }
}
