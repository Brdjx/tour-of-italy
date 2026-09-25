import type { ReactNode } from "react";

// Small line icons, drawn inline so they inherit the text color and need no image requests.
// Every icon is decorative: the button or label next to it carries the words.

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 20, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function SwapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h14" />
      <path d="m17 20 4-4-4-4" />
      <path d="M21 16H7" />
    </Svg>
  );
}

export function RemoveIcon(props: IconProps) {
  // Decision: a bin, not a minus: on phones Remove is an icon-only pill, and a lone minus read
  // as "collapse" rather than "take this stop out".
  return (
    <Svg {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.5 7l.9 12.2h9.2l.9-12.2" />
      <path d="M10.2 10.5v5.4M13.8 10.5v5.4" />
    </Svg>
  );
}

export function UpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 15 6-6 6 6" />
    </Svg>
  );
}

export function DownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </Svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12 5 5 9-10" />
    </Svg>
  );
}

/** Points down; rotate it 180 degrees for "open". */
export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function BackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

/** Two arrows out to opposite corners: open the map full screen. */
export function ExpandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 4H20v5.5" />
      <path d="m20 4-6.2 6.2" />
      <path d="M9.5 20H4v-5.5" />
      <path d="m4 20 6.2-6.2" />
    </Svg>
  );
}
