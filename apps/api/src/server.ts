import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { serviceStatus } from './status.js';
import { youtubeRoutes } from './youtube.js';
import { youtubeUploadRoutes } from './youtube-upload.js';
import { mediaRoutes } from './media.js';
import {
  createTelegramLink,
  getTelegramLinkStatus,
  handleTelegramUpdate,
  registerTelegramWebhook,
  webhookSecretMatches,
  type TelegramUpdate
} from "./telegram.js";

// OAuth authorization codes must never appear in request logs.
const app = Fastify({ logger: { serializers: { req: (req) => ({ method: req.method, url: req.url?.split('?')[0], hostname: req.hostname }) } } });
await app.register(youtubeRoutes);
await app.register(youtubeUploadRoutes);
await app.register(mediaRoutes);

app.get('/api/status', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return { services: await serviceStatus() };
});

await app.register(cors, {
  origin: config.WEB_ORIGIN,
  methods: ["GET", "POST"]
});

app.get("/health", async (_request, reply) => {
  if (!pool) return reply.code(503).send({ ok: false, database: "not_configured" });

  try {
    await pool.query("SELECT 1");
    return { ok: true, database: "connected" };
  } catch {
    return reply.code(503).send({ ok: false, database: "unreachable" });
  }
});

app.post("/api/telegram/link", async (_request, reply) => {
  try {
    return await createTelegramLink();
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({ error: "Telegram integration is not configured" });
  }
});

app.get("/api/telegram/link/:token", async (request, reply) => {
  const parsed = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).safeParse(request.params);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid link token" });

  try {
    const status = await getTelegramLinkStatus(parsed.data.token);
    return status ?? reply.code(404).send({ error: "Link not found" });
  } catch (error) {
    app.log.error(error);
    return reply.code(503).send({ error: "Database is unavailable" });
  }
});

app.post<{ Body: TelegramUpdate }>("/webhooks/telegram", async (request, reply) => {
  const secret = request.headers["x-telegram-bot-api-secret-token"];
  if (!webhookSecretMatches(typeof secret === "string" ? secret : undefined)) {
    return reply.code(401).send({ ok: false });
  }

  try {
    await handleTelegramUpdate(request.body);
    return { ok: true };
  } catch (error) {
    app.log.error(error);
    return reply.code(500).send({ ok: false });
  }
});

async function start() {
  await migrate();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  try {
    const registered = await registerTelegramWebhook();
    app.log.info(registered ? "Telegram webhook registered" : "Telegram webhook registration skipped");
  } catch (error) {
    app.log.warn(error, "Telegram webhook registration failed; API remains available");
  }
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool?.end();
    process.exit(0);
  });
}
