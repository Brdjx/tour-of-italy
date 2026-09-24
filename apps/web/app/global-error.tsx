"use client";

import "./globals.css";
import ErrorPage from "./error";

// Replaces the root layout when the layout itself fails, so it brings its own html, body and
// styles (Next does not apply the layout here). The message is the same as app/error.tsx.

export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <title>3 Days in Italy</title>
        <ErrorPage />
      </body>
    </html>
  );
}
