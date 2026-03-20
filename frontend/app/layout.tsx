import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mi Turno | Configuracion",
  description: "Panel de configuracion asistida para Mi Turno",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
