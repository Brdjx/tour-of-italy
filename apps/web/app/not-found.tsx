import type { Metadata } from "next";
import { PageMessage } from "../components/PageMessage";

// The 404 page (exported as 404.html), in the app's shell with a way back to the planner.

export const metadata: Metadata = { title: "Page not found | 3 Days in Italy" };

export default function NotFound() {
  return (
    <PageMessage
      title="This page does not exist."
      body="The address may be mistyped, or the page was moved. The trip planner is one tap away."
    >
      {/* A plain link, not next/link: it must work from any path of the static export. */}
      <a href="/" className="primary-button max-w-xs" data-testid="not-found-home">
        Go to the planner
      </a>
    </PageMessage>
  );
}
