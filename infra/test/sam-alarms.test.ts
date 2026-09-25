import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  METRIC_DIMENSION,
  METRIC_NAMES,
  METRIC_NAMESPACE,
} from "../../services/api/src/lib/metrics";
import { loadTemplate } from "./cfn-yaml";

// Alarms on the metrics the API function writes itself (Embedded Metric Format on its request log
// line). The names come from services/api/src/lib/metrics.ts, so renaming a metric there without
// the template fails here instead of leaving an alarm that can never fire.

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const template = loadTemplate(repoFile("infra/sam/template.yaml"));

type Props = Record<string, unknown>;
type MetricRef = { Namespace?: unknown; MetricName?: unknown; Dimensions?: unknown };

function alarm(name: string): Props {
  const found = template.Resources[name];
  if (found?.Type !== "AWS::CloudWatch::Alarm") throw new Error(`no alarm ${name}`);
  return found.Properties;
}

/** Every metric an alarm reads: the single metric, or each MetricStat of a math alarm. */
function metricsOf(props: Props): MetricRef[] {
  if (props.MetricName !== undefined) return [props as MetricRef];
  const queries = (props.Metrics ?? []) as { MetricStat?: { Metric: MetricRef } }[];
  return queries.flatMap((query) => (query.MetricStat ? [query.MetricStat.Metric] : []));
}

const customMetrics = Object.values(template.Resources)
  .filter((resource) => resource.Type === "AWS::CloudWatch::Alarm")
  .flatMap((resource) => metricsOf(resource.Properties))
  .filter((metric) => metric.Namespace === METRIC_NAMESPACE);

describe("SAM template: alarms on the function's own metrics", () => {
  it("reads only metric names and the dimension the API emits, so no alarm waits on a metric that never arrives", () => {
    const known = new Set<string>(Object.values(METRIC_NAMES));
    expect(customMetrics.length).toBeGreaterThanOrEqual(3);
    for (const metric of customMetrics) {
      expect(known.has(String(metric.MetricName)), String(metric.MetricName)).toBe(true);
      expect(metric.Dimensions).toEqual([
        { Name: METRIC_DIMENSION.name, Value: METRIC_DIMENSION.value },
      ]);
    }
  });

  it("alarms on a single handled 5xx, which the Lambda Errors metric never counts", () => {
    const props = alarm("HandledServerErrorsAlarm");
    expect(props.MetricName).toBe(METRIC_NAMES.serverErrors);
    expect(props.Threshold).toBe(1);
    expect(props.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(props.AlarmActions).toEqual([{ Ref: "AlarmTopic" }]);
  });

  it("alarms when the trips table fails, which otherwise only costs plans their saved why lines", () => {
    const props = alarm("TripStoreFailuresAlarm");
    expect(props.MetricName).toBe(METRIC_NAMES.tripStoreFailures);
    expect(props.Statistic).toBe("Sum");
    expect(props.TreatMissingData).toBe("notBreaching");
    expect(props.AlarmActions).toEqual([{ Ref: "AlarmTopic" }]);
  });

  it("alarms when most AI plans fall back because the model call fails, as with a revoked key", () => {
    const props = alarm("ModelFailuresAlarm");
    const names = metricsOf(props).map((metric) => metric.MetricName);
    expect(names.sort()).toEqual([METRIC_NAMES.aiPlans, METRIC_NAMES.modelFailures].sort());
    const queries = props.Metrics as { Id: string; Expression?: string; ReturnData: boolean }[];
    const returned = queries.filter((query) => query.ReturnData);
    expect(returned).toHaveLength(1);
    expect(returned[0]?.Expression).toMatch(/failures \/ plans/);
    expect(props.Threshold).toBe(0.5);
    expect(props.TreatMissingData).toBe("notBreaching");
    expect(props.AlarmActions).toEqual([{ Ref: "AlarmTopic" }]);
  });
});
