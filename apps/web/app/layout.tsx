import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Veil of Ages",
  description: "Панель інтеграцій Veil of Ages"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
