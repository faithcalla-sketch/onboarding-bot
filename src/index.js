import { Client, Events, GatewayIntentBits } from 'discord.js';
import { assertConfig, config, isTeamMember } from './config.js';
import { Store } from './store.js';
import { handleCommand } from './discord/commands.js';
import { handleInteraction } from './discord/interactions.js';
import { recordAck, runFollowupSweep } from './discord/actions.js';

const STORE_PATH = new URL('../data/state.json', import.meta.url).pathname;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function main() {
  assertConfig();

  const store = await new Store(STORE_PATH).load();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged: only needed to quote the client's reply back to the team.
      // Without it, replies are still detected, just without an excerpt.
      GatewayIntentBits.MessageContent,
    ],
  });
  const context = { store, client };

  client.once(Events.ClientReady, (ready) => {
    console.log(`Signed in as ${ready.user.tag}`);
    console.log(
      `Review channel: ${config.discord.reviewChannelId} · follow-up after ${config.followupHours}h · SMS ${config.ringcentral.enabled ? 'enabled' : 'disabled'}${config.dryRun ? ' · DRY_RUN' : ''}`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, context);
      } else if (interaction.isButton() || interaction.isModalSubmit()) {
        await handleInteraction(interaction, context);
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      const payload = { content: `⛔ Something went wrong: ${error.message}`, ephemeral: true };
      if (interaction.isRepliable()) {
        await (interaction.deferred || interaction.replied
          ? interaction.followUp(payload)
          : interaction.reply(payload)
        ).catch(() => {});
      }
    }
  });

  /**
   * The client answering in their own channel is the confirmation this whole
   * flow exists to get, so watch for it rather than making someone check.
   */
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const waiting = store.findByChannel(message.channelId);
    if (!waiting.length) return;

    for (const record of waiting) {
      const agentId = record.draft.agentDiscordId;
      if (agentId) {
        if (message.author.id !== agentId) continue;
      } else if (isTeamMember(message.author.id) || message.author.id === record.createdBy) {
        continue; // one of ours talking in the channel, not the client confirming
      }
      try {
        await recordAck(client, store, record, message);
      } catch (error) {
        console.error(`Could not record the reply for draft ${record.id}:`, error.message);
      }
    }
  });

  const sweep = setInterval(() => {
    runFollowupSweep(client, store).catch((error) =>
      console.error('Follow-up sweep failed:', error.message),
    );
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n${signal} — shutting down.`);
      clearInterval(sweep);
      client.destroy();
      process.exit(0);
    });
  }

  await client.login(config.discord.token);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
