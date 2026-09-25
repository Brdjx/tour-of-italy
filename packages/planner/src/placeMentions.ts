import type { PlannerContext } from "./context";

// Which dataset places a piece of AI text names, by full name or by a common short form. The API
// uses it to check what the model wrote (services/api/src/plan), and the page and the API both
// use it to keep an AI summary to the places a trip still has (summaryText.ts), so the traveler
// and whoever opens their saved trip see the same summary.

/** Lowercase letters and digits only, accents removed, words separated by single spaces. */
export function normalizeWords(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Decision: a short form must have two words or six letters, so a qualifier such as "(Exterior)"
// or a one-word stub never counts as a place name. Full names always count.
function isUsableForm(normal: string): boolean {
  return normal.split(" ").length >= 2 || normal.length >= 6;
}

/**
 * Name forms that count as naming a place: the full name, the part before the first comma
 * ("Ferrari Museum"), the part before a parenthesis ("Accademia Gallery"), a parenthetical of two
 * or more words ("Villa Borghese"), and each without a leading "the" ("Last Supper").
 */
export function nameForms(name: string): string[] {
  const forms = new Set<string>();
  const full = normalizeWords(name);
  if (full.length >= 3) forms.add(full);
  const shorter = [name.split(",")[0] ?? "", name.split("(")[0] ?? ""];
  for (const match of name.matchAll(/\(([^)]*)\)/g)) {
    const inner = normalizeWords(match[1] ?? "");
    if (inner.split(" ").length >= 2) shorter.push(inner);
  }
  for (const text of shorter) {
    const normal = normalizeWords(text);
    if (isUsableForm(normal)) forms.add(normal);
  }
  for (const form of [...forms]) {
    const rest = form.replace(/^the /, "");
    if (rest !== form && isUsableForm(rest)) forms.add(rest);
  }
  return [...forms];
}

const formsByContext = new WeakMap<PlannerContext, Map<string, string[]>>();

/** Place id -> its name forms, built once per context. */
function formsFor(ctx: PlannerContext): Map<string, string[]> {
  const known = formsByContext.get(ctx);
  if (known) return known;
  const forms = new Map<string, string[]>();
  for (const place of ctx.places) forms.set(place.id, nameForms(place.name));
  formsByContext.set(ctx, forms);
  return forms;
}

const containsWords = (outer: string, inner: string) => ` ${outer} `.includes(` ${inner} `);

/**
 * True when the text names a dataset place outside `allowed`. A name that is part of an allowed
 * place's own name does not count: "Trevi Fountain" inside "Trevi Fountain by Night".
 */
export function namesPlaceOutside(
  text: string,
  allowed: ReadonlySet<string>,
  ctx: PlannerContext,
): boolean {
  const forms = formsFor(ctx);
  const haystack = normalizeWords(text);
  const allowedForms = [...allowed].flatMap((id) => forms.get(id) ?? []);
  for (const [id, placeForms] of forms) {
    if (allowed.has(id)) continue;
    for (const form of placeForms) {
      if (!containsWords(haystack, form)) continue;
      if (!allowedForms.some((own) => containsWords(own, form))) return true;
    }
  }
  return false;
}
