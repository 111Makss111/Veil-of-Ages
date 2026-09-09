import Services from './services';

export default function Home() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '');
  return (
    <main>
      <section className="hero">
        <span className="eyebrow">VEIL OF AGES</span>
        <h1>Центр інтеграцій</h1>
        <p className="lead">Стан підключень і сервісів вашого проєкту.</p>
        <Services />
        {apiUrl && (
          <div>
            <p><a href={`${apiUrl}/media`}>Створити відео з картинки та музики</a></p>
            <p><a href={`${apiUrl}/youtube/upload`}>Завантажити готове відео на YouTube (приватно)</a></p>
          </div>
        )}
      </section>
    </main>
  );
}
