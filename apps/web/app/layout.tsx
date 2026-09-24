import type { Metadata, Viewport } from "next";
import { TikTok_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { expectPlanScript } from "../lib/expectPlanScript";
import "./globals.css";

// Decision: one family, self-hosted by next/font at build time, so the page makes no request to
// Google at runtime and the CSP can stay font-src 'self'. TikTok Sans is one variable font with
// every axis: weight 300 to 900, optical size 12 to 36 (applied from the font size), width 75 to
// 150 (font-stretch) and slant 0 to -6 (font-style: oblique).
const tiktokSans = TikTok_Sans({
  subsets: ["latin"],
  axes: ["opsz", "slnt", "wdth"],
  display: "swap",
  variable: "--font-tiktok-sans",
});

export const metadata: Metadata = {
  title: "3 Days in Italy",
  description:
    "Plan three days in Italy from a curated list of places, checked against opening hours and travel time.",
  applicationName: "3 Days in Italy",
  appleWebApp: {
    capable: true,
    title: "3 Days in Italy",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, address: false, email: false },
  // PNGs drawn from icons/icon.svg by scripts/generate-icons.ts. The manifest link comes from
  // app/manifest.ts.
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

// viewportFit "cover" lets the page draw under the notch and home indicator; the layout keeps
// its content inside the safe areas with the --safe-* custom properties in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#11110f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the head script below may add data-expect-plan before React runs.
    <html lang="en" className={tiktokSans.variable} suppressHydrationWarning>
      <head>
        {/* Decision: an inline script (the CSP allows them) so a returning traveler or a shared
            link never paints the empty form first; see lib/expectPlanScript.ts. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant built from our own code, no input. */}
        <script dangerouslySetInnerHTML={{ __html: expectPlanScript() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
