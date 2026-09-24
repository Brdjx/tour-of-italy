import { PlannerApp } from "../components/PlannerApp";

// The whole product is one page. It is exported as static HTML; everything after the first paint
// runs in the browser against the API (or the in-browser planner when the API is unreachable).
export default function HomePage() {
  return <PlannerApp />;
}
