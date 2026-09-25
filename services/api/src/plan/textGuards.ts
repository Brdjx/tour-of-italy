import { normalizeWords } from "@italy/planner";
import { REPAIR_INSTRUCTION, SYSTEM_PROMPT } from "../llm/prompt";

// Shared checks for model-written text (stop reasons and the trip summary). The model is told the
// rules; these make them true regardless of what it wrote. Every check errs toward dropping: a
// dropped reason falls back to the rule reason, and a dropped summary sentence is not shown.
// The checks that need the dataset are in placeMentions.ts (words the data never uses) and in
// the planner (namesPlaceOutside, place names), which also provides normalizeWords.

/** Control and invisible format characters removed, whitespace collapsed, trimmed. */
export function cleanText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const anyMatch = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

// Times, durations, and prices are the app's facts, computed in code. Model text must not state
// them, in digits ("9:30", "2-hour", "€15") or in words ("until 7", "opening hours").
const TIME_OR_PRICE: readonly RegExp[] = [
  /\b\d{1,2}[:.]\d{2}\b/,
  /\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i,
  /\d+\s*-?\s*(?:h|hr|hrs|hours?|mins?|minutes?)\b/i,
  // Decision: a small number after at/until/by is a clock time ("open until 7"), unless a unit
  // follows ("after 2 days in Rome").
  /\b(?:at|until|till|from|before|after|around|by|past)\s+\d{1,2}\b(?!\s*(?:days?|nights?|stops?|bases?|places?|visits?|km|kilometers?|miles?|people|of)\b)/i,
  /\bo'?clock\b|\bnoon\b|\bmidnight\b/i,
  /\b(?:hours?|minutes?|hrs|mins)\b/i,
  /\p{Sc}/u,
  /\beuros?\b|\bEUR\b/i,
];

// Rule 9 of the prompt forbids opening hours and prices in words too ("Closes early on Sundays
// and costs nothing"). The data behind such claims is in code; the model's version may be wrong.
// Decision: "close to" and "close by" are about distance and stay allowed; "free time" too.
const HOURS_OR_PRICE_WORDS: readonly RegExp[] = [
  /\bopen(?:s|ing)?\s+(?:until|till|from|at|on|daily|every|late|early|only|between|before|after|to|hours|times?|year)\b/i,
  /\b(?:is|are|stays?|remains?|be)\s+open\b/i,
  /\bclos(?:es|ed|ing|ures?)\b|\bclose\b(?!\s+(?:to|by|together)\b)(?!-)/i,
  /(?<!-)\bfree\b(?!\s+(?:time|afternoon|morning|evening|day|spirit)\b)/i,
  /\b(?:costs?|costing|prices?|priced|pricey|tickets?|admission|fees?|cheap(?:er|est)?|expensive|discount(?:s|ed)?|bargain)\b/i,
];

export function statesTimeOrPrice(text: string): boolean {
  return anyMatch(TIME_OR_PRICE, text) || anyMatch(HOURS_OR_PRICE_WORDS, text);
}

// Contact details and payment talk never belong in a reason or summary: they are how an
// injected note would send the traveler somewhere else ("book through evil.example").
const CONTACT_OR_PAYMENT: readonly RegExp[] = [
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i, // domain-like: evil.example, tickets.it
  /@/,
  /\+\s?\d|\d(?:[\s().-]*\d){6,}/, // phone-like: a + prefix, or seven digits in one run
  /\b(?:card|credit|debit|iban|cvv|cvc|password|passcode|pin|login|log\s+in|sign\s+in|credentials?|account|bank|wire|paypal|venmo|bitcoin|crypto|whatsapp|telegram|e-?mail|phone|call|text\s+us|contact|website|online)\b/i,
];

export function hasContactOrPayment(text: string): boolean {
  return anyMatch(CONTACT_OR_PAYMENT, text);
}

// Markup, links, role labels, and the usual injection phrases.
const MARKUP_OR_INJECTION: readonly RegExp[] = [
  /[<>{}`]/,
  /\[[^\]]*\]\s*\(/, // markdown link
  /\b(?:https?|ftp|file|javascript|vbscript|data)\s*:/i,
  /www\./i,
  /traveler_notes/i,
  /\bprompts?\b|\binstructions?\b/i,
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all|any|every|the|your|my|previous|prior|above|earlier|these|those|everything)\b/i,
  /\b(?:system|assistant|user|developer|human)\s*:/i,
  /\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\b|\bjailbreak\w*|\bunrestricted\b|\bdeveloper\s+mode\b/i,
];

// Decision: the same phrases in the languages a traveler is most likely to write in, matched on
// normalized words so accents cannot hide them ("istruzioni", "instrucciones", "instruções").
const FOREIGN_INJECTION_WORDS: readonly string[] = [
  "ignora",
  "ignorare",
  "ignorate",
  "ignorez",
  "ignorer",
  "ignoriere",
  "ignorieren",
  "dimentica",
  "olvida",
  "oublie",
  "vergiss",
  "istruzioni",
  "istruzione",
  "instrucciones",
  "instruccion",
  "instrucoes",
  "instrucao",
  "anweisungen",
  "anweisung",
  "consignes",
];

export function hasMarkupOrInjection(text: string): boolean {
  if (anyMatch(MARKUP_OR_INJECTION, text)) return true;
  const words = new Set(normalizeWords(text).split(" "));
  return FOREIGN_INJECTION_WORDS.some((word) => words.has(word));
}

/** Word five-grams of the prompt text the model sees; a sentence sharing one is a leak. */
const SHINGLE_WORDS = 5;

function shinglesOf(text: string): Set<string> {
  const words = normalizeWords(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    out.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  return out;
}

const PROMPT_SHINGLES = shinglesOf(`${SYSTEM_PROMPT}\n${REPAIR_INSTRUCTION}`);

// Decision: any five consecutive words from the prompt count as a leak. Shorter overlaps
// ("the candidate list") are normal English; five matching words in a row are not a coincidence.
export function echoesPrompt(text: string): boolean {
  for (const shingle of shinglesOf(text)) if (PROMPT_SHINGLES.has(shingle)) return true;
  return false;
}
