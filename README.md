# Tour of Italy

An interactive planner that builds a realistic three-day itinerary from a curated list of places in Italy.

## Quickstart

Requires Node 24 and pnpm (enable it with `corepack enable`).

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. The API runs on http://localhost:8787 (try `/api/health`).
No API key is needed. Without one, the rules-based planner builds every trip.

To use the AI planner locally, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API on port 8787 and web on port 3000 |
| `pnpm build` | Static web export (`apps/web/out`) and Lambda bundle (`services/api/dist`) |
| `pnpm check` | Lint, typecheck, and tests |
| `pnpm test:coverage` | Tests with a coverage report |
| `pnpm format` | Format every file with Biome |

## Project layout

| Path | Contents |
|---|---|
| `apps/web` | Next.js web app, exported as static files |
| `services/api` | Hono API, runs locally on Node and in production on AWS Lambda |
| `packages/planner` | Planning rules in plain TypeScript, shared by the API and the web app |
| `packages/evals` | Evaluation runs for the AI planner |
| `data/italy.json` | Source data, never edited |
| `docs` | Decisions, deploy guide, AI usage log |
