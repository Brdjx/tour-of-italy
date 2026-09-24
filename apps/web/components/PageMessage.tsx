import type { ReactNode } from "react";

// A whole-page message in the app's own shell (header, tokens, safe areas): the 404 page and the
// two error boundaries. No hooks, so the 404 page can render it at build time.

interface PageMessageProps {
  title: string;
  body: string;
  children: ReactNode; // the one next step: a link or a button
}

export function PageMessage({ title, body, children }: PageMessageProps) {
  return (
    <div className="app">
      <div className="status-scrim" aria-hidden="true" />
      <header className="app-header">
        <p className="t-title text-fg">3 Days in Italy</p>
      </header>
      <main className="page-message" data-testid="page-message">
        <h1 className="t-day text-fg">{title}</h1>
        <p className="mt-3 max-w-prose text-base text-muted">{body}</p>
        <div className="mt-6">{children}</div>
      </main>
    </div>
  );
}
