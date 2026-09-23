// Client for the planner API. The base URL is baked in at build time.

// Decision: an unset NEXT_PUBLIC_API_BASE means "local API" under `next dev` and "same origin" in
// a build. Production is served from one CloudFront origin, so a forgotten variable in CI still
// produces a working site instead of one that calls localhost.
export function resolveApiBase(
  configured: string | undefined,
  nodeEnv: string | undefined,
): string {
  if (configured !== undefined) {
    return configured.replace(/\/+$/, "");
  }
  return nodeEnv === "development" ? "http://localhost:8787" : "";
}

export const API_BASE = resolveApiBase(process.env.NEXT_PUBLIC_API_BASE, process.env.NODE_ENV);

export type Health = {
  ok: boolean;
  version: string;
  commit: string;
};

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch(`${API_BASE}/api/health`, { signal });
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  return (await response.json()) as Health;
}
