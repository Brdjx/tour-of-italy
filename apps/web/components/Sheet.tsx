"use client";

import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

// A sheet over the page, in the Apple manner: on phones it rises from the bottom with a grabber
// and can be dragged down to close; from 768 px it is a centred panel. Both sit over a dimmed,
// softly blurred page, and on phones the page behind scales back as on iOS
// (app/styles/sheet.css).
//
// It is the native <dialog> opened with showModal(), so the browser gives the focus trap, the
// inert page and Escape. Focus goes to `initialFocus` on open and back to `returnFocus` (or
// whatever had focus before) on close. A tap on the dimmed page closes it too. The sheet stays
// mounted while closed, so what the traveler typed in it survives closing and opening again.

/** "tall" reaches up to just under the status bar on phones; "fit" is as tall as its content. */
export type SheetSize = "tall" | "fit";

interface SheetProps {
  open: boolean;
  onClose: () => void; // the traveler asked to close it (close button, Escape, the page, a drag)
  labelledBy: string; // the id of the sheet's heading
  size: SheetSize;
  header: ReactNode; // the title and the sheet's actions, beside the grabber
  children: ReactNode;
  id?: string;
  className?: string;
  testId?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  returnFocus?: RefObject<HTMLElement | null>;
}

const PHONE = "(max-width: 767px)";
/** A drag closes the sheet past this share of its height, or when let go faster than this. */
const DISMISS_SHARE = 0.25;
const DISMISS_SPEED = 0.8; // px per ms, a flick
const DISMISS_MIN = 24; // px, so a flick on the grabber is not read as a close

interface Drag {
  pointer: number;
  startY: number;
  dy: number;
  lastY: number;
  lastT: number;
  speed: number;
}

// Decision: feature-checked, because jsdom (the unit tests) has <dialog> without showModal() or
// close(). There the open attribute alone shows it; the page's inertness is a browser matter.
export function showModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

/** A click outside the sheet's box: on the dimmed page, which the browser reports on the dialog. */
function outside(dialog: HTMLDialogElement, event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== dialog) return false;
  const box = dialog.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
}

function onPhone(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
}

export function Sheet(props: SheetProps) {
  const { open, labelledBy, size, header, children, id, className, testId } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef(props);
  latest.current = props;

  // Decision: a portal to <body>, so no ancestor's transform (the page scaling back, or the
  // sheet underneath) becomes this sheet's containing block while it leaves the top layer.
  // Rendered after mount: the static HTML has no <body> to portal into.
  useEffect(() => setHost(document.body), []);

  // Decision: a layout effect, so the page is interactive again before the page's own focus
  // rules run (passive effects): an inert page cannot take focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: host, because the dialog exists only once the portal has rendered.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
      // On phones the page scales back around the top of what is on screen (sheet.css).
      document.documentElement.style.setProperty("--recede-top", `${window.scrollY}px`);
      showModal(dialog);
      (latest.current.initialFocus?.current ?? dialog).focus({ preventScroll: true });
    } else if (!open && dialog.open) {
      const hadFocus = dialog.contains(document.activeElement);
      // A drag hands its offset to the exit transition: it leaves from where the finger let go.
      dialog.style.transform = "";
      delete dialog.dataset.dragging;
      drag.current = null;
      closeModal(dialog);
      const target = latest.current.returnFocus?.current ?? opener.current;
      if (hadFocus && target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [open, host]);

  const requestClose = () => latest.current.onClose();

  // Escape, from anywhere in the sheet. A control that used Escape itself (a search list
  // closing) marks it handled, and the sheet stays. Stopping it here keeps a sheet stacked on
  // another from closing both: React passes events up through portals.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    requestClose();
  };

  // The browser's own close request (Escape where keydown did not reach, the Android back
  // gesture): keep the dialog open and let the page close it with its motion.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    requestClose();
  };

  // Closed by something other than the page (a browser that ignores the cancel above).
  const onNativeClose = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return;
    if (latest.current.open) requestClose();
  };

  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (dialog && outside(dialog, event)) requestClose();
  };

  // Drag to close, from the grabber and the title row, on phones only.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (!dialog || event.button !== 0 || !onPhone()) return;
    if ((event.target as Element).closest("button, a, input, textarea, select")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      startY: event.clientY,
      dy: 0,
      lastY: event.clientY,
      lastT: event.timeStamp,
      speed: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    const current = drag.current;
    if (!dialog || !current || current.pointer !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - current.lastT);
    current.speed = (event.clientY - current.lastY) / elapsed;
    current.lastY = event.clientY;
    current.lastT = event.timeStamp;
    // Decision: down only. The sheet is already as tall as it goes; pulling up does nothing.
    current.dy = Math.max(0, event.clientY - current.startY);
    dialog.dataset.dragging = "true";
    dialog.style.transform = `translateY(${current.dy}px)`;
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    const current = drag.current;
    if (!dialog || !current || current.pointer !== event.pointerId) return;
    const far = current.dy > dialog.offsetHeight * DISMISS_SHARE;
    const fast = current.speed > DISMISS_SPEED && current.dy > DISMISS_MIN;
    if (event.type === "pointerup" && (far || fast)) {
      requestClose(); // the close above clears the drag once the page has said so
      return;
    }
    drag.current = null;
    delete dialog.dataset.dragging;
    dialog.style.transform = ""; // springs back to open (sheet.css)
  };

  if (!host) return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      id={id}
      aria-labelledby={labelledBy}
      aria-modal="true"
      className={`form-sheet form-sheet--${size}${className ? ` ${className}` : ""}`}
      onKeyDown={onKeyDown}
      onCancel={onCancel}
      onClose={onNativeClose}
      onClick={onClick}
      data-testid={testId}
    >
      <div
        className="form-sheet-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span className="form-sheet-grabber" aria-hidden="true" />
        <div className="form-sheet-head-row">{header}</div>
      </div>
      <div className="form-sheet-body">{children}</div>
    </dialog>,
    host,
  );
}

interface SheetTitleBarProps {
  titleId: string;
  titleRef: RefObject<HTMLHeadingElement | null>; // the sheet's initialFocus
  title: ReactNode;
  titleTestId?: string;
  // A line under the title. When given (even as null while the sheet empties on close), the
  // title and it stand together in one block, so the close pill stays at the top.
  subtitle?: ReactNode;
  closeLabel: string; // "Close details", "Back to plan"
  closeTestId: string;
  onClose: () => void;
}

/**
 * The header of a sheet that is for reading: its title (focused on open) and the round close
 * pill, as Edit trip, a stop's or a place's details and About this data all show it. More options
 * keeps its own header, with Clear options and Done.
 */
export function SheetTitleBar(props: SheetTitleBarProps) {
  const heading = (
    <h2
      id={props.titleId}
      ref={props.titleRef}
      tabIndex={-1}
      className="form-sheet-title t-title outline-none"
      data-testid={props.titleTestId}
    >
      {props.title}
    </h2>
  );
  return (
    <>
      {props.subtitle === undefined ? (
        heading
      ) : (
        <div className="details-sheet-heading">
          {heading}
          {props.subtitle}
        </div>
      )}
      <button
        type="button"
        className="pill pill--quiet pill--round form-sheet-close"
        onClick={props.onClose}
        aria-label={props.closeLabel}
        data-testid={props.closeTestId}
      >
        <CloseIcon size={22} />
      </button>
    </>
  );
}
