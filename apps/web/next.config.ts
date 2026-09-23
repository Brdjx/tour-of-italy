import type { NextConfig } from "next";

// Decision: static export. CloudFront serves the files from a private S3 bucket, so there is no
// Node server to run or patch in production. trailingSlash makes every route a folder with an
// index.html, which S3 serves without rewrite rules.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@italy/planner"],
  reactStrictMode: true,
  // Decision: stop `next dev` from writing AGENTS.md and CLAUDE.md into the app folder. The
  // repo keeps one set of contributor docs; the Next.js guides stay in node_modules/next/dist/docs.
  agentRules: false,
};

export default nextConfig;
