'use client';

import { useEffect, useRef, useState } from 'react';

const moods = [
  { name: 'Поза часом', label: '01 / DEEP ATMOSPHERE', text: 'Приглуши світ навколо. Залиш місце для музики й власних думок.', art: 'deep' },
  { name: 'Ближче до світла', label: '02 / SOFT ENERGY', text: 'Повільний подих, тепле світло та простір для нового відчуття.', art: 'light' },
  { name: 'За горизонтом', label: '03 / WIDE IMAGINATION', text: 'Звуки та образи, з яких починається твоя наступна історія.', art: 'wide' },
];

export default function StudioMotion() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [visible, setVisible] = useState(true);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    const visibility = () => setVisible(!document.hidden);
    sync(); visibility();
    query.addEventListener('change', sync);
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in-view'); observer.unobserve(entry.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.section').forEach(section => observer.observe(section));
    return () => { observer.disconnect(); query.removeEventListener('change', sync); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('motion-paused', paused || !visible);
    return () => document.documentElement.classList.remove('motion-paused');
  }, [paused, visible]);
  useEffect(() => {
    if (paused || reduced || !visible) return;
    const timer = setInterval(() => setActive(value => (value + 1) % moods.length), 7000);
    return () => clearInterval(timer);
  }, [paused, reduced, visible]);
  function move(direction: number) { setPaused(true); setActive(value => (value + direction + moods.length) % moods.length); }
  return <>
    <button className="motion-toggle" onClick={() => setPaused(value => !value)} aria-pressed={paused}>{paused ? '▷ Увімкнути рух' : 'Ⅱ Призупинити рух'}</button>
    <section className="mood-section section" aria-label="Настрої студії" aria-roledescription="карусель"
      onFocusCapture={() => setPaused(true)} onTouchStart={event => { touch.current = event.touches[0]?.clientX ?? null; }}
      onTouchEnd={event => { const end = event.changedTouches[0]?.clientX; if (touch.current !== null && end !== undefined && Math.abs(end - touch.current) > 45) move(end < touch.current ? 1 : -1); touch.current = null; }}>
      <div className="mood-heading"><p className="eyebrow">EXPLORE THE FEELING</p><span>Три настрої. Один всесвіт.</span></div>
      <div className="mood-stage">
        {moods.map((mood, index) => <article key={mood.art} className={`mood-slide ${mood.art} ${index === active ? 'is-active' : ''}`} aria-hidden={index !== active} inert={index !== active}>
          <div className="mood-landscape" aria-hidden="true"><div className="mood-sun"/><div className="mood-hill hill-back"/><div className="mood-hill hill-front"/><div className="mood-grain"/></div>
          <div className="mood-copy"><p className="eyebrow">{mood.label}</p><h2>{mood.name}</h2><p>{mood.text}</p><a href="#listen">Зустрінемося на YouTube ↗</a></div>
        </article>)}
      </div>
      <div className="slider-controls"><div className="slider-dots">{moods.map((mood, index) => <button key={mood.art} aria-label={`Показати: ${mood.name}`} aria-pressed={active === index} onClick={() => { setPaused(true); setActive(index); }}><span/></button>)}</div><span aria-live={paused ? 'polite' : 'off'}>0{active + 1} / 03</span><div><button aria-label="Попередній настрій" onClick={() => move(-1)}>←</button><button aria-label="Наступний настрій" onClick={() => move(1)}>→</button></div></div>
    </section>
  </>;
}
