import { version as plannerVersion } from "@italy/planner";
import { HealthStatus } from "../components/HealthStatus";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold">Italy trip planner</h1>
      <p>Plan three days in Italy from a curated list of places.</p>
      <HealthStatus />
      <p className="text-sm">Planner {plannerVersion}</p>
    </main>
  );
}
