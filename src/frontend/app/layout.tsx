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
    default: "Stripboard Editor — Design Stripboard Layouts Online",
    template: "%s | Stripboard Editor",
  },
  description:
    "Free online stripboard layout editor. Copper strips colour-code to your nets in real time so you can instantly see what's connected. Design, place, and verify — no more tracing strips by hand.",
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
    title: "Stripboard Editor — Design Stripboard Layouts Online",
    description:
      "Free online stripboard editor with live strip colouring. See net connectivity at a glance — strips light up in your net colours.",
    images: [
      {
        url: "/stripboard-editor-example.png",
        width: 1920,
        height: 1014,
        alt: "Stripboard Editor — layout view",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Stripboard Editor — Design Stripboard Layouts Online",
    description:
      "Free online stripboard editor with live strip colouring. See net connectivity at a glance.",
    images: ["/stripboard-editor-example.png"],
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
