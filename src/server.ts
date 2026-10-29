import mongoose from "mongoose";
import { loadConfig } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { createApp } from "./app.js";
import { log } from "./utils/logger.js";
import {createImageStorage} from "./services/image-storage.js";
import {ImageCleanupService} from "./services/image-cleanup.js";
try {
  const config = loadConfig();
  await connectDatabase(config.MONGODB_URI);
  const images = createImageStorage(config);
  const cleanup = new ImageCleanupService(images);
  let cleanupRunning = false;
  const retryCleanup = async () => {
    if (cleanupRunning || !images) return;
    cleanupRunning = true;
    try {await cleanup.retryPending();} catch {log("error", "catalog_image_cleanup_worker_failed");}
    finally {cleanupRunning = false;}
  };
  const cleanupTimer = setInterval(() => {void retryCleanup();}, 60_000);
  cleanupTimer.unref();
  void retryCleanup();
  const server = createApp(config, {images}).listen(config.PORT, () =>
    log("info", "server_started", { port: config.PORT }),
  );
  server.on("error", () => {
    log("error", "server_failed");
    process.exitCode = 1;
    void mongoose.disconnect();
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanupTimer);
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(() => {
      void mongoose.disconnect().then(() => {
        clearTimeout(timeout);
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  log("error", "startup_failed", {
    message:
      error instanceof Error &&
      error.message.startsWith("Invalid configuration:")
        ? error.message
        : "Unable to start; check database availability and configuration",
  });
  process.exitCode = 1;
}
