import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Veil of Ages",
  description: "Veil of Ages — незалежна музична та візуальна студія. Музика, образи та атмосферні історії."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
