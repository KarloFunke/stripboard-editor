import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = SITE_URL;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Stripboard Editor - Design Stripboard Layouts Online",
    template: "%s | Stripboard Editor",
  },
  description:
    "Free online stripboard layout editor with a built-in schematic editor. Draw schematics with standard symbols, then place components on a virtual stripboard. Copper strips colour-code to your nets in real time so you can instantly see what is connected — then print a true-scale build template with a mirrored cut guide and a bill of materials (BOM).",
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
    "printable stripboard template",
    "bill of materials",
    "BOM",
  ],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "Stripboard Editor",
    title: "Stripboard Editor - Design Stripboard Layouts Online",
    description:
      "Free online stripboard editor with a built-in schematic editor. Draw circuits with standard symbols, wire up nets, and layout on a virtual stripboard with live strip colouring — then print a 1:1 build template with a parts list (BOM).",
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
      "Free online stripboard editor with a built-in schematic editor. Draw circuits, wire up nets, layout on a virtual stripboard, and print a 1:1 build template with a BOM.",
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
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`,
          }}
        />
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
