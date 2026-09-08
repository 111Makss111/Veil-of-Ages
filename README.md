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

У Vercel оберіть:

- Root Directory: залиште порожнім (корінь репозиторію);
- Framework Preset: `Next.js`;
- Build Command і Output Directory: задаються кореневим `vercel.json` — збирається лише вебсайт, результат `apps/web/.next`.

Якщо проєкт уже використовує Root Directory `apps/web`, там також є окремий `vercel.json` з результатом `.next`.
Після змін пуште новий commit: Redeploy старого commit не включає нові файли конфігурації.

Потім додайте змінну:

- `NEXT_PUBLIC_API_URL=https://<RENDER_HOST>`

## Перевірка

Панель читає `/api/status` на Render при відкритті сторінки та натисканні кнопки оновлення. Періодичних перевірок немає.
Neon перевіряється SQL-запитом; Telegram — getMe і адресою webhook. Прив’язка вашого
Telegram перевіряється окремо. Vercel означає завантаження цього сайту з Vercel,
а Render — доступність нашого API, не стан усіх ресурсів акаунта.
Якщо API недоступний, залежні сервіси показують «Немає даних».

Майбутні інтеграції (змінні додаються тільки в Render, зараз не обов’язкові):

| Сервіс | Змінні | Що перевіряється |
|---|---|---|
| n8n | `N8N_URL`, `N8N_API_KEY` | Авторизоване читання `/api/v1/workflows?limit=1` |
| cron-job.org | `CRON_JOB_API_KEY` | Доступ до списку завдань, не їх виконання. Результат кешується 30 хвилин через квоту API |
| Docker | `DOCKER_HEALTH_URL`, `DOCKER_HEALTH_TOKEN` | Захищений агент має реально перевірити Docker і повернути JSON `{"service":"docker","ok":true}`. Агент ще не розгорнуто; Docker socket/керуючий API не відкривати в інтернет |
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_SETUP_SECRET` | Оновлення збереженого OAuth-токена. Не є підтвердженням успішного завантаження відео |

Без значень ці сервіси показують «Не налаштовано». Звичайні перевірки кешуються
30 секунд, YouTube — 5 хвилин; час на картці показує момент фактичної перевірки.
API повертає лише статуси, без ключів, адрес підключення та особистих даних.

```bash
npm run check
npm run build
```

## Підключення YouTube (власник проєкту)

1. Google OAuth client: Web application, scope `https://www.googleapis.com/auth/youtube.upload`.
2. Redirect URI: `https://<RENDER_HOST>/auth/youtube/callback` (без завершального слеша).
3. У Render додайте `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` та випадковий
   `YOUTUBE_SETUP_SECRET` (32+ символи; можна Generate у Render). Збережіть цей
   секрет у менеджері паролів. Не додавайте його до Vercel або Git.
4. Після розгортання нового коду відкрийте `https://<RENDER_HOST>/auth/youtube`.
   Введіть секрет налаштування, оберіть свій Google-акаунт і надайте дозвіл.
5. Refresh token зберігається в Neon, зашифрований AES-256-GCM. Вручну копіювати
   його не потрібно. Зміна setup secret робить старий токен нечитабельним;
   після зміни потрібно підключитися заново. Старий `YOUTUBE_REFRESH_TOKEN`
   підтримується як fallback, якщо запису в базі немає.

Сесія одноразова, діє 10 хвилин, прив'язана до браузера, використовує state та PKCE.
Коди авторизації не журналюються. У Testing Google може обмежувати строк дії
доступу; якщо він відкликаний або минув, повторіть підключення.
Зараз реалізовано лише отримання доступу: завантажувач відео ще не додано.
