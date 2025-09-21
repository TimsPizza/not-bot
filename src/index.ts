// src/index.ts
import "dotenv/config"; // Ensure dotenv is loaded early
import BotClient from "@/client";
import loggerService from "@/logger";
import contextManagerService from "@/context"; // Import to ensure it's initialized if not already
import configService from "@/config"; // Import to ensure it's initialized if not already

// Ensure core services are instantiated (though they should be by their own imports)
// This is more for clarity and potential future async initializations.
loggerService;
configService;
contextManagerService;

loggerService.logger.info("Starting application...");

const botClient = new BotClient();

// Start the bot
botClient.start().catch((error) => {
  loggerService.logger.fatal({ err: error }, "Failed to start bot client");
  process.exit(1);
});

// --- Graceful Shutdown ---
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

signals.forEach((signal) => {
  process.on(signal, async () => {
    loggerService.logger.info(
      `Received ${signal}. Initiating graceful shutdown...`,
    );
    try {
      await botClient.stop();
      loggerService.logger.info("Graceful shutdown complete.");
      process.exit(0);
    } catch (error) {
      loggerService.logger.error({ err: error }, "Error during graceful shutdown");
      process.exit(1);
    }
  });
});

// --- Optional: Handle Uncaught Errors ---
process.on("uncaughtException", (error, origin) => {
  loggerService.logger.fatal({ err: error, origin }, "Uncaught exception");
  // Consider a more robust shutdown here if needed, but often exiting is safest
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  loggerService.logger.error({ promise, reason }, "Unhandled rejection");
  // Optional: Exit on unhandled rejections? Depends on application needs.
  // process.exit(1);
});

loggerService.logger.info("Application setup complete. Bot is running.");
