import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { expectPlanScript } from "../lib/expectPlanScript";
import "./globals.css";

// Decision: one family, self-hosted by next/font at build time, so the page makes no request to
// Google at runtime and the CSP can stay font-src 'self'.
const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-schibsted",
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
    { media: "(prefers-color-scheme: light)", color: "#f4f6f5" },
    { media: "(prefers-color-scheme: dark)", color: "#11191f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the head script below may add data-expect-plan before React runs.
    <html lang="en" className={schibsted.variable} suppressHydrationWarning>
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
