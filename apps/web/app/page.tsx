"use client";

import { useEffect, useState } from "react";
import Services from './services';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type LinkState = { token: string; url: string; expiresAt: string };

export default function Home() {
  const [link, setLink] = useState<LinkState | null>(null);
  const [status, setStatus] = useState<"idle" | "creating" | "waiting" | "connected" | "error">("idle");
  const [connectedName, setConnectedName] = useState("");

  useEffect(() => {
    if (!link || status !== "waiting") return;

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${apiUrl}/api/telegram/link/${link.token}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();

        if (data.status === "connected") {
          setConnectedName(data.username ? `@${data.username}` : data.firstName ?? "Telegram");
          setStatus("connected");
        } else if (data.status === "expired") {
          setStatus("error");
        }
      } catch {
        // Keep polling through temporary network errors.
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [link, status]);

  async function connectTelegram() {
    setStatus("creating");
    try {
      const response = await fetch(`${apiUrl}/api/telegram/link`, { method: "POST" });
      if (!response.ok) throw new Error("API unavailable");
      const data: LinkState = await response.json();
      setLink(data);
      setStatus("waiting");
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main>
      <section className="hero">
        <span className="eyebrow">VEIL OF AGES</span>
        <h1>Центр інтеграцій</h1>
        <p className="lead">Стан підключень і сервісів вашого проєкту.</p>

        <Services />

        <div className="telegram-card">
          <div>
            <span className="card-label">TELEGRAM</span>
            <h2>{status === "connected" ? "Telegram підключено" : "Підключіть Telegram"}</h2>
            <p>
              {status === "connected"
                ? `Зв’язок із ${connectedName} підтверджено.`
                : "Відкрийте бота та натисніть Start. Підтвердження з’явиться тут автоматично."}
            </p>
          </div>

          {status === "connected" ? (
            <span className="success">✓ Підключено</span>
          ) : (
            <div className="actions">
              <button onClick={connectTelegram} disabled={status === "creating" || status === "waiting"}>
                {status === "creating" && "Створюю посилання…"}
                {status === "waiting" && "Очікую підтвердження…"}
                {(status === "idle" || status === "error") && "Підключити Telegram"}
              </button>
              {status === "waiting" && link && (
                <a href={link.url} target="_blank" rel="noreferrer">Відкрити Telegram ще раз</a>
              )}
            </div>
          )}
        </div>

        {status === "error" && (
          <p className="error">Не вдалося підключитися. Перевірте налаштування API та спробуйте ще раз.</p>
        )}
      </section>
    </main>
  );
}
