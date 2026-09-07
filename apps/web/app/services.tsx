'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Result = { id: string; state: string; detail: string; checkedAt?: string };
const names: Record<string, string> = { vercel: 'Vercel', render: 'Render', neon: 'Neon', telegram: 'Telegram · бот', cron: 'cron-job.org', docker: 'Docker', n8n: 'n8n', youtube: 'YouTube' };
const labels: Record<string, string> = { connected: 'Підключено', error: 'Помилка', not_configured: 'Не налаштовано', unknown: 'Немає даних', checking: 'Перевірка…' };

export default function Services() {
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    const now = new Date().toISOString();
    const vercel: Result = { id: 'vercel', state: process.env.NEXT_PUBLIC_VERCEL_ENV ? 'connected' : 'unknown', detail: process.env.NEXT_PUBLIC_VERCEL_ENV ? 'Сторінка завантажена з розгортання Vercel' : 'Сторінка працює; хостинг Vercel не підтверджено', checkedAt: now };
    const api = process.env.NEXT_PUBLIC_API_URL;
    try {
      if (!api) throw new Error('Missing API URL');
      const response = await fetch(`${api.replace(/\/$/, '')}/api/status`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('API unavailable');
      const data = await response.json();
      if (!Array.isArray(data.services) || !Object.keys(names).filter(id => id !== 'vercel').every(id => data.services.some((s: Result) => s.id === id && ['connected', 'error', 'not_configured'].includes(s.state) && typeof s.detail === 'string'))) throw new Error('Invalid response');
      setResults([vercel, ...data.services]);
    } catch {
      setResults([vercel, ...Object.keys(names).filter(id => id !== 'vercel').map(id => ({ id, state: id === 'render' ? (api ? 'error' : 'not_configured') : 'unknown', detail: id === 'render' ? (api ? 'API не відповів. Можливі пробудження Render, помилка адреси або CORS.' : 'Додайте NEXT_PUBLIC_API_URL у Vercel та розгорніть сайт повторно') : 'Неможливо перевірити без відповіді API', checkedAt: now }))]);
    } finally { active.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
    return () => clearInterval(timer);
  }, [refresh]);
  return <>
    <div className="status-toolbar"><p>Автоперевірка щохвилини. Статус бота окремий від прив’язки вашого Telegram.</p><button disabled={busy} onClick={() => void refresh()}>{busy ? 'Перевіряю…' : 'Оновити статуси'}</button></div>
    <div className="grid" aria-label="Сервіси проєкту" aria-live="polite">
      {Object.entries(names).map(([id, name]) => {
        const result = results.find(item => item.id === id);
        const state = result?.state ?? 'checking';
        return <article className={`service state-${state}`} key={id}>
          <span className="dot" aria-hidden="true" />
          <div><strong>{name}</strong><small className="status-label">{labels[state] ?? 'Немає даних'}</small><small>{result?.detail ?? 'Очікую результат перевірки'}</small>{result?.checkedAt && <small>Перевірено: {new Date(result.checkedAt).toLocaleTimeString('uk-UA')}</small>}</div>
        </article>;
      })}
    </div>
  </>;
}
