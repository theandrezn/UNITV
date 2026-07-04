import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNITV Agent",
  description: "Technical foundation for the UNITV support automation system"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
