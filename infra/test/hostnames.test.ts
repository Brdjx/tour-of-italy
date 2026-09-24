import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The host names live in four places: the platform (certificate, aliases, DNS), the bootstrap
// (the deploy role's Route 53 conditions), deploy.yml (smoke test and guard targets) and the
// docs. A rename in one place only fails late: the deploy role gets AccessDenied on DNS after
// sam deploy has already run, or the smoke test checks a host nobody serves.

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repoFile(path), "utf8");

function variableDefault(path: string, name: string): string {
  const match = read(path).match(
    new RegExp(`variable "${name}" \\{[\\s\\S]*?default\\s*=\\s*"([^"]+)"`),
  );
  if (!match?.[1]) throw new Error(`default of ${name} not found in ${path}`);
  return match[1];
}

function hostsIn(path: string): string[] {
  return [...read(path).matchAll(/[a-z0-9.-]+\.brdjx\.com/g)].map((match) => match[0]);
}

function filesIn(directory: string, extension: string): string[] {
  const entries = readdirSync(repoFile(directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(directory, entry.name));
}

type DeployWorkflow = {
  env: Record<string, string>;
  jobs: Record<string, { environment?: { url?: string } }>;
};

const site = variableDefault("infra/terraform/platform/variables.tf", "site_domain");
const api = variableDefault("infra/terraform/platform/variables.tf", "api_domain");

describe("host names agree across infra, CI and the docs", () => {
  it("serves the web app and the API on the two names the owner chose", () => {
    expect(site).toBe("italy-planner.brdjx.com");
    expect(api).toBe("api.italy-planner.brdjx.com");
  });

  it("lets the deploy role write DNS for exactly the names the platform creates", () => {
    const bootstrap = "infra/terraform/bootstrap/variables.tf";
    expect(variableDefault(bootstrap, "site_domain")).toBe(site);
    expect(variableDefault(bootstrap, "api_domain")).toBe(api);
  });

  it("smoke tests and guards the hosts the platform serves", () => {
    const workflow = parse(read(".github/workflows/deploy.yml")) as DeployWorkflow;
    expect(workflow.env.SITE_URL).toBe(`https://${site}`);
    expect(workflow.env.API_URL).toBe(`https://${api}`);
    expect(workflow.jobs.deploy?.environment?.url).toBe(`https://${site}`);
  });

  it("never mentions a brdjx.com host other than the two in use", () => {
    const files = [
      "docs/deploy.md",
      ...filesIn(".github/workflows", ".yml"),
      ...filesIn(".github/scripts", ".sh"),
      ...filesIn("infra/terraform/platform", ".tf"),
      ...filesIn("infra/terraform/bootstrap", ".tf"),
    ];
    for (const file of files) {
      for (const host of hostsIn(file)) expect([site, api], `${file}: ${host}`).toContain(host);
    }
  });
});
