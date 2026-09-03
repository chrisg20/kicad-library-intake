import type { Metadata } from "next";
import "./globals.css";

const basePath = process.env.PAGES_BASE_PATH?.replace(/\/$/, "") || "";

export const metadata: Metadata = {
  title: "KiCad Library Intake",
  description: "Normalize KiCad symbols, footprints, and 3D models before committing them to a Git library.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: `${basePath}/favicon.svg`,
    shortcut: `${basePath}/favicon.svg`,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
