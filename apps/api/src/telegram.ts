import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { requirePool } from "./db.js";

type TelegramMessage = {
  chat?: { id?: number };
  from?: { id?: number; username?: string; first_name?: string };
  text?: string;
};

export type TelegramUpdate = { message?: TelegramMessage };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function webhookSecretMatches(received: string | undefined): boolean {
  if (!received || !config.TELEGRAM_WEBHOOK_SECRET) return false;
  const expected = Buffer.from(config.TELEGRAM_WEBHOOK_SECRET);
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createTelegramLink() {
  if (!config.TELEGRAM_BOT_USERNAME) throw new Error("TELEGRAM_BOT_USERNAME is not configured");

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + config.LINK_TTL_MINUTES * 60_000);

  await requirePool().query(
    `INSERT INTO telegram_links (id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [randomUUID(), hashToken(token), expiresAt]
  );

  return {
    token,
    url: `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${token}`,
    expiresAt: expiresAt.toISOString()
  };
}

export async function getTelegramLinkStatus(token: string) {
  const result = await requirePool().query<{
    status: "pending" | "connected" | "expired";
    telegram_username: string | null;
    telegram_first_name: string | null;
    expires_at: Date;
  }>(
    `SELECT status, telegram_username, telegram_first_name, expires_at
     FROM telegram_links WHERE token_hash = $1`,
    [hashToken(token)]
  );

  const link = result.rows[0];
  if (!link) return null;

  if (link.status === "pending" && link.expires_at.getTime() <= Date.now()) {
    await requirePool().query(
      `UPDATE telegram_links SET status = 'expired' WHERE token_hash = $1 AND status = 'pending'`,
      [hashToken(token)]
    );
    return { status: "expired" as const };
  }

  return {
    status: link.status,
    username: link.telegram_username,
    firstName: link.telegram_first_name
  };
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const match = message?.text?.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{32})$/);
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;

  if (!match?.[1] || !userId || !chatId) return;

  const result = await requirePool().query(
    `UPDATE telegram_links
     SET status = 'connected', telegram_user_id = $1, telegram_chat_id = $2,
         telegram_username = $3, telegram_first_name = $4, connected_at = NOW()
     WHERE token_hash = $5 AND status = 'pending' AND expires_at > NOW()
     RETURNING id`,
    [userId, chatId, message.from?.username ?? null, message.from?.first_name ?? null, hashToken(match[1])]
  );

  if (result.rowCount) {
    await sendTelegramMessage(chatId, "✅ Telegram успішно підключено до Veil of Ages. Можна повертатися на сайт.");
  }
}

export async function registerTelegramWebhook(): Promise<boolean> {
  const publicApiUrl = config.PUBLIC_API_URL
    ?? (config.RENDER_EXTERNAL_HOSTNAME ? `https://${config.RENDER_EXTERNAL_HOSTNAME}` : undefined);

  if (!publicApiUrl || !config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_WEBHOOK_SECRET) return false;

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `${publicApiUrl.replace(/\/$/, "")}/webhooks/telegram`,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"]
    })
  });

  if (!response.ok) throw new Error(`Telegram setWebhook failed with ${response.status}`);
  return true;
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) return;

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!response.ok) throw new Error(`Telegram sendMessage failed with ${response.status}`);
}
