import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url().optional(),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  PUBLIC_API_URL: z.string().url().optional(),
  RENDER_EXTERNAL_HOSTNAME: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8).optional(),
  LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10)
});

export const config = schema.parse(process.env);
