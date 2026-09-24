import type { CSSProperties } from "react";

// Placeholders in the shape of what is loading. Every skeleton is hidden from assistive
// technology: the container that waits carries aria-busy, and the page's live region says what
// is happening. The colour is the Rule token and the pulse stops under reduced motion
// (app/styles/skeleton.css). Each shape reserves the height of the real control, so nothing
// moves when the real content replaces it.

interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  className?: string;
  testId?: string;
}

export function Skeleton({ width, height, className, testId }: SkeletonProps) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <span
      className={className ? `skeleton ${className}` : "skeleton"}
      style={style}
      aria-hidden="true"
      data-testid={testId}
    />
  );
}

// Decision: fixed, varied widths instead of random ones. The static HTML and the first render
// in the browser must match, and a row of identical pills reads as a pattern, not as chips.
const CHIP_WIDTHS = [104, 132, 84, 112, 96, 124, 88, 140] as const;

/** Chips shaped like the interest and base choices: 44 px pills of varied widths. */
export function SkeletonChips({ count, testId }: { count: number; testId?: string }) {
  return (
    <div className="flex flex-wrap gap-2" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of identical placeholders.
          key={index}
          className="skeleton--chip"
          width={CHIP_WIDTHS[index % CHIP_WIDTHS.length]}
        />
      ))}
    </div>
  );
}

/** A text field's box, the height of .text-input. */
export function SkeletonField({ testId }: { testId?: string }) {
  return <Skeleton className="skeleton--field" testId={testId} />;
}
