import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { asset } from "./asset";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ocean Assistant",
  description: "Ocean data for Pacific Island countries, with an AI assistant that runs in your browser",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        {/* Cesium's widget styles, served from public/cesium (scripts/copy-assets.mjs). */}
        <link rel="stylesheet" href={asset("/cesium/Widgets/widgets.css")} />
      </head>
      <body>{children}</body>
    </html>
  );
}
