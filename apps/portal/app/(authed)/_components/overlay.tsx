'use client';

import {
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

/**
 * Shared accessible-overlay behaviors (modals, drawers, slide-overs).
 *
 * Every floating dialog in the app gets the same four things keyboard and
 * screen-reader users were missing (the overlays previously only closed via a
 * backdrop click):
 *   1. Escape closes.
 *   2. Tab is trapped inside the dialog (with wrap-around).
 *   3. Focus moves into the dialog on open and RETURNS to the opener on close.
 *   4. The page behind stops scrolling (body scroll lock).
 *
 * Callers attach the returned ref to the dialog container and spread
 * `role="dialog" aria-modal="true"` + a label (aria-label / aria-labelledby)
 * themselves — or use the `Modal` / `Drawer` shells below, which do it for
 * them.
 */
/**
 * Module-level stack of open dialogs. Only the TOPMOST dialog handles
 * Escape/Tab — without this, a modal opened from inside a drawer would
 * double-close on one Escape (both document listeners fire; stopPropagation
 * doesn't stop OTHER listeners on the same node) and the two focus traps would
 * fight over every Tab press.
 */
const dialogStack: HTMLElement[] = [];

export function useDialogBehaviors<T extends HTMLElement>(args: {
  onClose: () => void;
  /** Extra keydown handling AFTER Escape/Tab (e.g. the gap drawer's J/K
   *  prev/next). Fires only for keys not already consumed. */
  onKeyDown?: (e: KeyboardEvent) => void;
}): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Keep the latest callbacks without re-running the mount effect.
  const onCloseRef = useRef(args.onClose);
  onCloseRef.current = args.onClose;
  const onKeyDownRef = useRef(args.onKeyDown);
  onKeyDownRef.current = args.onKeyDown;

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    dialogStack.push(el);

    // (3) Save the opener, move focus in: the first [autofocus], else the
    // first focusable control, else the container itself.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const auto = el.querySelector<HTMLElement>('[autofocus]');
    const target = auto ?? firstFocusable(el) ?? el;
    if (target === el) el.tabIndex = -1; // make the container focusable as a fallback
    target.focus();

    // (4) Scroll lock. The authed layout scrolls <main> (the body is
    // h-dvh/overflow-hidden), so locking the body alone is a no-op there —
    // lock BOTH, restoring prior inline values on close so nested/sequential
    // overlays don't clobber each other.
    const scrollers: { node: HTMLElement; prior: string }[] = [];
    for (const node of [document.body, document.querySelector<HTMLElement>('main')]) {
      if (node === null) continue;
      scrollers.push({ node, prior: node.style.overflow });
      node.style.overflow = 'hidden';
    }

    const keydown = (e: KeyboardEvent): void => {
      // Only the topmost dialog responds; lower dialogs wait their turn.
      if (dialogStack[dialogStack.length - 1] !== el) return;
      if (e.key === 'Escape') {
        // stopImmediatePropagation: stop OTHER document-level listeners too
        // (a second dialog's handler is on the same node).
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        // (2) Trap with wrap-around.
        const focusables = allFocusable(el);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !el.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !el.contains(active))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      onKeyDownRef.current?.(e);
    };
    document.addEventListener('keydown', keydown);

    return () => {
      document.removeEventListener('keydown', keydown);
      const idx = dialogStack.indexOf(el);
      if (idx !== -1) dialogStack.splice(idx, 1);
      // Restore in reverse so the outermost value wins when overlays unwind.
      for (const { node, prior } of scrollers.reverse()) {
        node.style.overflow = prior;
      }
      opener?.focus();
    };
  }, []);

  return ref;
}

/**
 * Lightweight behaviors for the hand-rolled dropdown menus (kebab/assign/
 * picker popovers): while open, Escape closes and focus returns to the element
 * that was focused when the menu opened (the trigger). Outside-click stays the
 * caller's invisible-backdrop button. Attach by calling with the menu's open
 * state + close setter.
 */
export function useMenuBehaviors(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const keydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Don't let a parent dialog's Escape handler also fire (close the menu,
        // not the drawer behind it).
        e.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    // Capture phase so the menu wins over a parent dialog's document listener.
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      opener?.focus();
    };
  }, [open]);
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function firstFocusable(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
}

function allFocusable(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (n) => n.offsetParent !== null || n === document.activeElement,
  );
}

/**
 * Centered modal dialog: scrim + card, Escape/trap/focus-return/scroll-lock.
 * The card stops backdrop-click propagation; clicking the scrim closes.
 */
export function Modal({
  onClose,
  ariaLabel,
  children,
  maxWidthClass = 'max-w-md',
}: {
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  /** Tailwind max-width class for the card (default max-w-md). */
  maxWidthClass?: string;
}): ReactElement {
  const ref = useDialogBehaviors<HTMLDivElement>({ onClose });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${maxWidthClass} rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-pop)]`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Right-side slide-over with the same dialog behaviors. The caller renders the
 * drawer's content (header/body); `onKeyDown` is the hook's pass-through for
 * drawer-specific keys (e.g. J/K gap navigation).
 */
export function Drawer({
  onClose,
  ariaLabel,
  children,
  onKeyDown,
}: {
  onClose: () => void;
  ariaLabel: string;
  children: ReactNode;
  onKeyDown?: (e: KeyboardEvent) => void;
}): ReactElement {
  const ref = useDialogBehaviors<HTMLElement>({ onClose, ...(onKeyDown ? { onKeyDown } : {}) });
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="relative z-50 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-bg shadow-[var(--shadow-pop)]"
      >
        {children}
      </aside>
    </div>
  );
}
