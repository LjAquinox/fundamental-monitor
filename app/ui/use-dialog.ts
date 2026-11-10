import { useEffect, useRef } from "react";

/** Stable focus/scroll cleanup; changing a callback must not reopen the dialog. */
export function useDialog(close: () => void, busy = false) {
  const ref = useRef<HTMLElement>(null),
    latest = useRef({ close, busy });
  latest.current = { close, busy };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape" && !latest.current.busy) {
        e.preventDefault();
        latest.current.close();
      }
      if (e.key !== "Tab") return;
      const nodes = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length > 0);
      if (!nodes.length) {
        e.preventDefault();
        return;
      }
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) {
        try {
          previous.focus?.();
        } catch {
          /* A removed or disabled element cannot regain focus. */
        }
      }
    };
  }, []);
  return ref;
}
