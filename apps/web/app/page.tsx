import Services from './services';

export default function Home() {
  return (
    <main>
      <section className="hero">
        <span className="eyebrow">VEIL OF AGES</span>
        <h1>Центр інтеграцій</h1>
        <p className="lead">Стан підключень і сервісів вашого проєкту.</p>
        <Services />
      </section>
    </main>
  );
}
