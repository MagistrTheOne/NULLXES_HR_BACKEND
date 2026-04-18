import { env } from "./config/env";
import { logger } from "./logging/logger";
import { createApp } from "./app";

const { app, sessionStore, webhookDispatcher, postMeetingProcessor } = createApp();
sessionStore.startSweeper();
webhookDispatcher.start();
postMeetingProcessor.start();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      nodeEnv: env.NODE_ENV
    },
    "realtime gateway listening"
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, "graceful shutdown started");

  sessionStore.stopSweeper();
  webhookDispatcher.stop();
  postMeetingProcessor.stop();
  server.close((err) => {
    if (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
      return;
    }

    logger.info("server shutdown complete");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
