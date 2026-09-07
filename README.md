# Veil of Ages

Стартовий інтеграційний проєкт:

- **Vercel** — вебсайт (`apps/web`)
- **Render** — TypeScript API та Telegram webhook (`apps/api`)
- **Neon** — PostgreSQL
- **Telegram** — прив'язка користувача через одноразове deep link-посилання

## Як працює прив'язка Telegram

1. Користувач натискає «Підключити Telegram» на сайті.
2. API створює одноразовий код у Neon.
3. Відкривається бот за адресою `t.me/<bot>?start=<code>`.
4. Telegram надсилає `/start <code>` у webhook API на Render.
5. API позначає код як використаний і зберігає Telegram ID.
6. Сайт бачить статус `connected`.

## Локальний запуск

```bash
npm install
copy .env.example apps\api\.env
copy apps\web\.env.example apps\web\.env.local
npm run dev
```

Вебсайт: `http://localhost:3000`

API: `http://localhost:4000`

Для повної перевірки потрібні Neon connection string і Telegram bot token.

## Змінні для Render

Render читає `render.yaml`. Після створення Web Service додайте:

- `DATABASE_URL` — pooled connection string із Neon;
- `TELEGRAM_BOT_TOKEN` — токен від BotFather;
- `TELEGRAM_BOT_USERNAME` — username бота без `@`;
- `TELEGRAM_WEBHOOK_SECRET` — випадковий секрет (Render може згенерувати);
- `WEB_ORIGIN` — production URL сайту на Vercel, наприклад `https://veil-of-ages.vercel.app`.

Після deploy API автоматично зареєструє захищений Telegram webhook, використовуючи адресу, яку надає Render. Для локального тунелю можна додатково задати `PUBLIC_API_URL`.

## Змінні для Vercel

У Vercel оберіть Root Directory `apps/web` і додайте:

- `NEXT_PUBLIC_API_URL=https://<RENDER_HOST>`

## Перевірка

```bash
npm run check
npm run build
```
