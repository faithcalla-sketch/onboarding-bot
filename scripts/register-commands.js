import { REST, Routes } from 'discord.js';
import { assertConfig, config } from '../src/config.js';
import { commands } from '../src/discord/commands.js';

/**
 * Registers /notify and /pending on your server. Run once after setup, and
 * again whenever a command's options change.
 */
async function main() {
  assertConfig();
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const result = await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: commands },
  );
  console.log(`Registered ${result.length} command(s): ${result.map((c) => `/${c.name}`).join(', ')}`);
}

main().catch((error) => {
  console.error('Command registration failed:', error.message);
  process.exit(1);
});
