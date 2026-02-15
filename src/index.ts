import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { debug } from "./debug.js";
import { handleMessage } from "./messageHandler.js";
import { startCleanupInterval } from "./sessionManager.js";
import { handleDiffButtonInteraction } from "./diffInteraction.js";
import { startDiffCleanup } from "./diffStore.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  for (const [channel, cwd] of config.channels) {
    console.log(`Watching channel: #${channel} → ${cwd}`);
  }
  if (config.debug) console.log("Debug mode enabled");
  startCleanupInterval();
  startDiffCleanup();
});

client.on("messageCreate", (message) => {
  handleMessage(message).catch((error) => {
    console.error("[bot] Unhandled error in messageCreate:", error);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("diff:") && !interaction.customId.startsWith("hide-diff:")) return;

  try {
    await handleDiffButtonInteraction(interaction);
  } catch (error) {
    console.error("[bot] Error handling diff button:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: "Failed to load diff.", ephemeral: true })
        .catch(() => {});
    }
  }
});

client.login(config.discordToken);
