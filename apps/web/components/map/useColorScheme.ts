import { useEffect, useState } from "react";
import type { ColorScheme } from "../../lib/mapStyle";

const DARK = "(prefers-color-scheme: dark)";

function current(): ColorScheme {
  return window.matchMedia?.(DARK).matches ? "dark" : "light";
}

/** The system colour scheme, updated live when it changes (the page's own theme follows it). */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(current);
  useEffect(() => {
    const query = window.matchMedia?.(DARK);
    if (!query) return;
    const update = () => setScheme(query.matches ? "dark" : "light");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return scheme;
}
