// Type-level helpers for the compile-time checks at the bottom of schemas.ts and dataSchemas.ts:
// each asserts that a Zod schema's output and its hand-written type in types.ts still agree, so
// the two cannot drift apart without the build failing.

/** Compiles only when T is exactly `true`. */
export type Assert<T extends true> = T;

/**
 * true when A is assignable to B. The tuple wrap ([A] extends [B]) stops TypeScript from
 * distributing over unions, so a union type is compared as a whole rather than member by member.
 */
export type Extends<A, B> = [A] extends [B] ? true : false;

/** true when A and B are assignable both ways: the same type for every practical purpose. */
export type Both<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;
