/**
 * Main entry point — Express server with webhook endpoints.
 */

import "dotenv/config";
import express from "express";
import { config } from "./config.js";
import { gmailWebhookHandler } from "./webhooks/gmail.js";
import { renewGmailWatch } from "./gmail/watch.js";
import { logger } from "./utils/logger.js";

async function main() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Admin: renew Gmail watch — called daily by Cloud Scheduler
  app.post("/admin/renew-watch", async (req, res) => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || token !== config.adminSecret) {
      res.status(401).send("Unauthorized");
      return;
    }
    try {
      const result = await renewGmailWatch();
      res.json(result);
    } catch (err) {
      logger.error(err, "Failed to renew Gmail watch");
      res.status(500).send("Failed");
    }
  });

  // Gmail Pub/Sub push notifications
  app.post("/webhooks/gmail", gmailWebhookHandler);

  app.listen(config.port, () => {
    logger.info({ port: config.port }, "Server started");
    logger.info("Endpoints:");
    logger.info("  GET  /health");
    logger.info("  POST /webhooks/gmail");
    logger.info("  POST /admin/renew-watch");
  });
}

main().catch((err) => {
  logger.error(err, "Startup failed");
  process.exit(1);
});
