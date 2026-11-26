import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Navo",
  description: "Local traces, performance, policies, usage, and billing seams.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
