import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isApprover } from '../config.js';
import { buildDraft } from '../message.js';
import { ACTIONS, buildCustomId, parseCustomId } from './review.js';
import { deliverDiscord, deliverSms, refreshReviewMessage } from './actions.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };
const EDIT_MODAL = 'edit_modal';

/**
 * The record's "sent" flag is only written once the send returns, so two people
 * hitting Approve at the same moment would both pass the check and the client
 * would get the message twice. Hold the record for the duration of the send.
 */
const inFlight = new Set();

async function reject(interaction, message) {
  const payload = { content: message, ...EPHEMERAL };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => {});
  } else {
    await interaction.reply(payload).catch(() => {});
  }
}

function buildEditModal(record) {
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId(EDIT_MODAL, record.id))
    .setTitle(`Edit draft ${record.id}`.slice(0, 45));

  const message = new TextInputBuilder()
    .setCustomId('body')
    .setLabel('Message to the client')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1900)
    .setRequired(true)
    .setValue(record.draft.discordBody.slice(0, 1900));

  const date = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Go-live date (YYYY-MM-DD, Friday, 8/24…)')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(40)
    .setRequired(false)
    .setValue(record.draft.goLiveDate || record.draft.rawDate || '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(message),
    new ActionRowBuilder().addComponents(date),
  );
  return modal;
}

/**
 * Rebuild the draft from the Trello card so a date change flows through every
 * rendering of it (Discord body, SMS body, warnings), then re-apply whatever
 * wording the human typed.
 */
async function applyEdit(store, record, { body, date }) {
  if (!record.card) {
    throw new Error('The original Trello card is no longer in this draft. Run `/notify` again.');
  }
  const fresh = await buildDraft({
    card: record.card,
    dateOverride: date || record.draft.goLiveDate || record.draft.rawDate || '',
    channelOverride: record.draft.channelId || '',
  });
  if (body && body.trim()) {
    fresh.discordBody = body.trim();
    fresh.edited = true;
    if (fresh.discordBody.length > 2000) {
      fresh.problems.push('The edited message is over Discord\'s 2000-character limit.');
      fresh.canSendDiscord = false;
    }
  }
  return store.update(record.id, { draft: fresh });
}

export async function handleInteraction(interaction, { store, client }) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  const record = store.get(parsed.recordId);
  if (!record) {
    await reject(interaction, 'That draft is no longer in the bot\'s records. Run `/notify` again.');
    return;
  }
  if (!isApprover(interaction.user.id)) {
    await reject(interaction, 'You are not on the approver list (`APPROVER_IDS`).');
    return;
  }

  if (interaction.isModalSubmit() && parsed.action === EDIT_MODAL) {
    await interaction.deferUpdate();
    try {
      const updated = await applyEdit(store, record, {
        body: interaction.fields.getTextInputValue('body'),
        date: interaction.fields.getTextInputValue('date'),
      });
      await refreshReviewMessage(client, updated);
    } catch (error) {
      await reject(interaction, `⛔ ${error.message}`);
    }
    return;
  }

  if (!interaction.isButton()) return;

  if (parsed.action === ACTIONS.EDIT) {
    if (record.discord?.sent || record.sms?.sent) {
      await reject(interaction, 'This has already gone out — editing it here would not change what the client received.');
      return;
    }
    await interaction.showModal(buildEditModal(record));
    return;
  }

  await interaction.deferUpdate();

  if (inFlight.has(record.id)) {
    await reject(interaction, '⏳ That draft is already being sent — give it a second.');
    return;
  }
  inFlight.add(record.id);

  try {
    switch (parsed.action) {
      case ACTIONS.SEND_DISCORD: {
        const updated = await deliverDiscord(client, store, record, interaction.user);
        await refreshReviewMessage(client, updated);
        await interaction.followUp({
          content: `✅ Sent to <#${updated.draft.channelId}>. I will flag it here if they have not replied in a few hours.`,
          ...EPHEMERAL,
        });
        break;
      }
      case ACTIONS.SEND_SMS: {
        const updated = await deliverSms(store, record, interaction.user);
        await refreshReviewMessage(client, updated);
        await interaction.followUp({
          content: `✅ Texted ${updated.sms.to}.`,
          ...EPHEMERAL,
        });
        break;
      }
      case ACTIONS.NUDGE_SMS: {
        const updated = await deliverSms(store, record, interaction.user, { nudge: true });
        await refreshReviewMessage(client, updated);
        await interaction.editReply({ components: [] }).catch(() => {});
        await interaction.followUp({
          content: `✅ Nudge texted to ${updated.sms.to}.`,
          ...EPHEMERAL,
        });
        break;
      }
      case ACTIONS.DISCARD: {
        const updated = await store.update(record.id, { status: 'cancelled' });
        await refreshReviewMessage(client, updated);
        await interaction.followUp({ content: '🗑 Discarded — nothing was sent.', ...EPHEMERAL });
        break;
      }
      default:
        await reject(interaction, `Unknown action \`${parsed.action}\`.`);
    }
  } catch (error) {
    console.error(`Action ${parsed.action} failed for draft ${record.id}:`, error);
    await reject(interaction, `⛔ ${error.message}`);
  } finally {
    inFlight.delete(record.id);
  }
}
