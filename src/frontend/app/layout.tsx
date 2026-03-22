import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = "https://stripboard-editor.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Stripboard Editor - Design Stripboard Layouts Online",
    template: "%s | Stripboard Editor",
  },
  description:
    "Free online stripboard layout editor with a built-in schematic editor. Draw schematics with standard symbols, then place components on a virtual stripboard. Copper strips colour-code to your nets in real time so you can instantly see what is connected.",
  keywords: [
    "stripboard",
    "veroboard",
    "circuit layout",
    "stripboard editor",
    "electronics",
    "PCB layout",
    "through-hole",
    "prototype",
    "schematic editor",
  ],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "Stripboard Editor",
    title: "Stripboard Editor - Design Stripboard Layouts Online",
    description:
      "Free online stripboard editor with a built-in schematic editor. Draw circuits with standard symbols, wire up nets, and layout on a virtual stripboard with live strip colouring.",
    images: [
      {
        url: "/demo-circuit.png",
        width: 1920,
        height: 963,
        alt: "Stripboard Editor showing schematic and board layout side by side",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Stripboard Editor - Design Stripboard Layouts Online",
    description:
      "Free online stripboard editor with a built-in schematic editor. Draw circuits, wire up nets, and layout on a virtual stripboard.",
    images: ["/demo-circuit.png"],
  },
  alternates: {
    canonical: siteUrl,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="light" style={{ colorScheme: "light" }}>
      <head>
        <Script
          defer
          src="https://umami.karl-funke.com/script.js"
          data-website-id="0398ea5c-5fb2-4b70-b07d-df3e158ac172"
          strategy="afterInteractive"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
