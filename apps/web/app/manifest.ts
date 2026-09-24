import type { MetadataRoute } from "next";

// The web app manifest, written to out/manifest.webmanifest at build time (no request-time
// APIs, so the static export can emit it). Next adds the <link rel="manifest"> tag itself.

export const dynamic = "force-static";

/** The page background in the light scheme (see globals.css). */
const MANIFEST_THEME_COLOR = "#ffffff";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "3 Days in Italy",
    short_name: "3 Days Italy",
    description:
      "Plan three days in Italy from a curated list of places, checked against opening hours and travel time.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Decision: one colour pair, from the light tokens. The manifest has no per-scheme colours;
    // the per-scheme theme-color meta tags in layout.tsx take over once the page loads, so this
    // only tints the launch screen.
    theme_color: MANIFEST_THEME_COLOR,
    background_color: MANIFEST_THEME_COLOR,
    categories: ["travel"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
