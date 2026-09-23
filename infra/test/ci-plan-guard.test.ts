import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The plan role (infra/terraform/bootstrap) trusts only runs started by github_actor_ids. The ci.yml
// plan job must skip for everyone else: a failed AssumeRole would fail ci-ok on every Dependabot
// or collaborator pull request, while a skipped plan is allowed.

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

function bootstrapActorIds(): string[] {
  const variables = readFileSync(repoFile("infra/terraform/bootstrap/variables.tf"), "utf8");
  const block = variables.match(/variable "github_actor_ids" \{[\s\S]*?default\s*=\s*\[([^\]]*)\]/);
  if (!block?.[1]) throw new Error("github_actor_ids default not found in bootstrap/variables.tf");
  return [...block[1].matchAll(/"(\d+)"/g)].map((match) => match[1] as string);
}

function planJobCondition(): string {
  const workflow = parse(readFileSync(repoFile(".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, { if?: string }>;
  };
  const condition = workflow.jobs.plan?.if;
  if (!condition) throw new Error("ci.yml has no plan job condition");
  return condition;
}

describe("ci.yml plan job and the plan role trust", () => {
  const trusted = bootstrapActorIds();
  const condition = planJobCondition();

  it("runs the plan for every account the plan role trusts, so their pull requests get a plan", () => {
    expect(trusted.length).toBeGreaterThan(0);
    for (const id of trusted) expect(condition).toContain(`github.actor_id == '${id}'`);
  });

  it("skips the plan for accounts the plan role rejects, so their pull requests do not fail ci-ok", () => {
    const inWorkflow = [...condition.matchAll(/github\.actor_id == '(\d+)'/g)].map((m) => m[1]);
    expect(inWorkflow.length).toBeGreaterThan(0);
    for (const id of inWorkflow) expect(trusted).toContain(id);
  });

  it("never runs the plan for fork pull requests, which get no OIDC token", () => {
    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });
});
