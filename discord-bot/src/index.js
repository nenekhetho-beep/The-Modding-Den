'use strict';

const config = require('./config'); // validates env vars first; exits early if any are missing
const { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const { startHealthServer } = require('./health');
const { startModrinthPolling } = require('./modrinth');
const { commands, handleInteraction } = require('./tickets');

// Only the Guilds intent is needed: slash commands, buttons, channel + role caches.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let stopPolling = null;
const healthServer = startHealthServer(client);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.clientId), {
    body: commands.map((command) => command.toJSON()),
  });
  console.log(`[commands] Registered ${commands.length} slash command(s).`);
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] Logged in as ${readyClient.user.tag}`);
  stopPolling = startModrinthPolling(readyClient);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error('[interaction] Unhandled error:', err);
    if (!interaction.isRepliable()) return;
    const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.on(Events.Error, (err) => console.error('[client] Error:', err));
process.on('unhandledRejection', (reason) => console.error('[process] Unhandled rejection:', reason));

async function shutdown(signal) {
  console.log(`[process] ${signal} received, shutting down…`);
  stopPolling?.();
  healthServer.close();
  await client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  try {
    await registerCommands();
    await client.login(config.discordToken);
  } catch (err) {
    console.error('[startup] Fatal error:', err);
    process.exit(1); // Railway's ON_FAILURE restart policy takes over
  }
})();
