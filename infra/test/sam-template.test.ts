import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../services/api/src/config";
import { loadTemplate } from "./cfn-yaml";

// Guards on infra/sam/template.yaml. Each test names the production failure it prevents.

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const template = loadTemplate(repoFile("infra/sam/template.yaml"));
const configSource = readFileSync(repoFile("services/api/src/config.ts"), "utf8");
const samconfig = readFileSync(repoFile("infra/sam/samconfig.toml"), "utf8");
const nodeMajor = readFileSync(repoFile(".nvmrc"), "utf8").trim().replace(/^v/, "").split(".")[0];

type Props = Record<string, unknown>;

function resource(name: string): Props {
  const found = template.Resources[name];
  if (!found) throw new Error(`template has no resource ${name}`);
  return found.Properties;
}

const fn = resource("ApiFunction");
const env = (fn.Environment as { Variables: Record<string, unknown> }).Variables;

// Keys of the zod object in config.ts, read from the source so a new variable there shows up here.
function configKeys(): string[] {
  const start = configSource.indexOf(".object({");
  const body = configSource.slice(start, configSource.indexOf("\n  })", start));
  return [...body.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1] as string);
}

// Resolves { Ref: Param } to the parameter's default, the value a plain `sam deploy` would use.
function resolveDefault(value: unknown): string {
  if (typeof value === "string") return value;
  const ref = (value as { Ref?: string }).Ref;
  const parameter = ref ? template.Parameters[ref] : undefined;
  if (parameter?.Default === undefined) throw new Error(`cannot resolve ${JSON.stringify(value)}`);
  return String(parameter.Default);
}

describe("SAM template: timeouts and capacity", () => {
  it("keeps the function timeout under API Gateway's 30 s cap so slow plans never become gateway 503s", () => {
    expect(fn.Timeout).toBeTypeOf("number");
    expect(fn.Timeout as number).toBeLessThan(30);
  });

  it("gives the function more time than the plan deadline so the rules-only fallback can still answer", () => {
    const deadlineMs = Number(env.PLAN_DEADLINE_MS);
    const llmTimeoutMs = Number(env.LLM_TIMEOUT_MS);
    expect(llmTimeoutMs).toBeLessThan(deadlineMs);
    expect(deadlineMs + 3000).toBeLessThanOrEqual((fn.Timeout as number) * 1000);
  });

  it("caps reserved concurrency so a traffic spike cannot run up the Claude bill or starve other stacks", () => {
    expect(fn.ReservedConcurrentExecutions).toBeTypeOf("number");
    expect(fn.ReservedConcurrentExecutions as number).toBeGreaterThan(0);
    expect(fn.ReservedConcurrentExecutions as number).toBeLessThanOrEqual(20);
  });

  it("throttles the HTTP API so a flood is refused before it reaches the function", () => {
    const settings = resource("HttpApi").DefaultRouteSettings as Props;
    expect(settings.ThrottlingBurstLimit).toBeTypeOf("number");
    expect(settings.ThrottlingRateLimit).toBeTypeOf("number");
    expect(settings.ThrottlingBurstLimit as number).toBeGreaterThan(0);
    expect(settings.ThrottlingBurstLimit as number).toBeLessThanOrEqual(200);
    expect(settings.ThrottlingRateLimit as number).toBeLessThanOrEqual(100);
  });

  it("throttles plans below reserved concurrency, so a plan flood cannot starve page loads", () => {
    const routes = resource("HttpApi").RouteSettings as Record<string, Props>;
    const plan = routes["POST /api/plan"] as Props;
    const reads = resource("HttpApi").DefaultRouteSettings as Props;
    expect(plan.ThrottlingBurstLimit as number).toBeGreaterThan(0);
    expect(plan.ThrottlingBurstLimit as number).toBeLessThan(
      fn.ReservedConcurrentExecutions as number,
    );
    expect(plan.ThrottlingRateLimit as number).toBeLessThan(reads.ThrottlingRateLimit as number);
  });
});

describe("SAM template: runtime and logs", () => {
  it("runs the Node major pinned in .nvmrc so production runs what CI tested", () => {
    expect(fn.Runtime).toBe(`nodejs${nodeMajor}.x`);
  });

  it("builds for arm64, the architecture the bundle targets", () => {
    expect(fn.Architectures).toEqual(["arm64"]);
  });

  it("keeps function logs for 14 days so they neither vanish before an incident review nor pile up cost", () => {
    const logGroup = resource("ApiLogGroup");
    expect(logGroup.RetentionInDays).toBe(14);
    expect(logGroup.LogGroupName).toBe(`/aws/lambda/${fn.FunctionName}`);
    expect((fn.LoggingConfig as Props).LogGroup).toEqual({ Ref: "ApiLogGroup" });
  });

  it("serves the prebuilt bundle from services/api/dist with the lambda.handler export", () => {
    expect(fn.CodeUri).toBe("../../services/api/dist");
    expect(fn.Handler).toBe("lambda.handler");
  });
});

describe("SAM template: environment matches services/api/src/config.ts", () => {
  it("sets only variables config.ts reads, so a typo cannot silently fall back to a default", () => {
    const known = new Set([...configKeys(), "NODE_OPTIONS"]);
    expect(configKeys().length).toBeGreaterThan(5);
    for (const name of Object.keys(env)) {
      expect(known.has(name), `${name} is not read by config.ts`).toBe(true);
    }
  });

  it("sets every variable config.ts reads except the local-only PORT and ANTHROPIC_API_KEY", () => {
    const expected = configKeys().filter((key) => key !== "PORT" && key !== "ANTHROPIC_API_KEY");
    expect(Object.keys(env).sort()).toEqual([...expected, "NODE_OPTIONS"].sort());
  });

  it("never puts the Anthropic key itself in the function environment", () => {
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(JSON.stringify(env)).not.toMatch(/sk-ant-/);
  });

  it("passes config validation in production mode, so the function never fails at cold start", () => {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) resolved[name] = resolveDefault(value);
    const config = loadConfig(resolved);
    expect(config.isProduction).toBe(true);
    expect(config.originVerifyParam).toBe("/italy-planner/origin-verify-secret");
    expect(config.anthropicKeyParam).toBe("/italy-planner/anthropic-api-key");
  });

  it("reports the deployed commit, so the smoke test can prove the new code is live", () => {
    expect(env.GIT_SHA).toEqual({ Ref: "GitSha" });
    expect(template.Parameters.GitSha?.AllowedPattern).toBeDefined();
  });

  it("enables source maps so production stack traces point at real lines", () => {
    expect(env.NODE_OPTIONS).toBe("--enable-source-maps");
  });
});

describe("SAM template: least privilege for the function", () => {
  const role = resource("ApiFunctionRole");
  const statements = (role.Policies as Array<{ PolicyDocument: { Statement: Props[] } }>).flatMap(
    (policy) => policy.PolicyDocument.Statement,
  );

  it("creates the function role inside the italy-planner boundary, so CI can never mint an unbounded role", () => {
    expect(role.PermissionsBoundary).toEqual({ Ref: "PermissionsBoundaryArn" });
    // The deploy role may create, change and pass exactly this role name (bootstrap/arns.tf).
    expect(role.RoleName).toBe("italy-planner-api-function");
    expect(template.Parameters.PermissionsBoundaryArn?.AllowedPattern).toContain(
      "italy-planner-boundary",
    );
  });

  it("grants no wildcard actions to the function role", () => {
    for (const statement of statements) {
      const actions = ([] as unknown[]).concat(statement.Action);
      for (const action of actions) expect(String(action)).not.toMatch(/(^\*$|:\*$)/);
    }
  });

  it("lets the function read only its two SSM parameters, both under /italy-planner/", () => {
    const ssm = statements.find((statement) => statement.Sid === "ReadOwnParameters");
    // The ARNs are !Sub strings that end in parameter${<ParameterName>}.
    const subRef = (name: string) => `parameter\${${name}}`;
    expect(JSON.stringify(ssm?.Resource)).toContain(subRef("AnthropicKeyParam"));
    expect(JSON.stringify(ssm?.Resource)).toContain(subRef("OriginVerifyParam"));
    expect(template.Parameters.AnthropicKeyParam?.Default).toBe("/italy-planner/anthropic-api-key");
    expect(template.Parameters.OriginVerifyParam?.Default).toBe(
      "/italy-planner/origin-verify-secret",
    );
  });
});

describe("SAM template: contract with CI and the platform", () => {
  it("exposes the outputs deploy.yml, the smoke test and infra/terraform/platform read", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual([
      "ApiFunctionName",
      "HttpApiDomain",
      "HttpApiId",
      "HttpApiUrl",
    ]);
  });

  it("outputs the HTTP API id the bootstrap pins the deploy role to, so the pin is copied, not guessed", () => {
    expect(template.Outputs.HttpApiId?.Value).toEqual({ Ref: "HttpApi" });
  });

  it("routes only /api/* to the function, with the plan route separate for its throttle", () => {
    const events = fn.Events as Record<string, { Type: string; Properties: Props }>;
    const routes = Object.values(events).map(
      (event) => `${event.Type} ${event.Properties.Method} ${event.Properties.Path}`,
    );
    expect(routes.sort()).toEqual(["HttpApi ANY /api/{proxy+}", "HttpApi POST /api/plan"]);
    // A route setting for a route that does not exist fails the deploy.
    const keys = Object.values(events).map((e) => `${e.Properties.Method} ${e.Properties.Path}`);
    for (const key of Object.keys(resource("HttpApi").RouteSettings as Props)) {
      expect(keys).toContain(key);
    }
  });

  it("names resources with the italy-planner prefix the deploy role is scoped to", () => {
    expect(fn.FunctionName).toBe("italy-planner-api");
    expect(resource("HttpApi").Name).toBe("italy-planner-api");
    expect(resource("AlarmTopic").TopicName).toMatch(/^italy-planner-/);
    for (const [name, value] of Object.entries(template.Resources)) {
      if (value.Type === "AWS::CloudWatch::Alarm") {
        expect(String(value.Properties.AlarmName), name).toMatch(/^italy-planner-/);
        expect(value.Properties.AlarmActions).toEqual([{ Ref: "AlarmTopic" }]);
      }
    }
  });

  it("deploys through samconfig to the stack and artifacts bucket the IAM policies expect", () => {
    expect(samconfig).toMatch(/^stack_name = "italy-planner-api"$/m);
    expect(samconfig).toMatch(/^s3_bucket = "italy-planner-artifacts-388773186626"$/m);
    expect(samconfig).toMatch(/^s3_prefix = "italy-planner-api"$/m);
    expect(samconfig).not.toMatch(/^resolve_s3/m);
    expect(samconfig).toMatch(
      /PermissionsBoundaryArn=arn:aws:iam::388773186626:policy\/italy-planner-boundary/,
    );
    expect(samconfig).toMatch(/Project=\\"italy-planner\\"/);
  });
});
