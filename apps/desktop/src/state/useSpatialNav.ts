import { useEffect } from "react";
import { pickNext, type Direction } from "../lib/spatial";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';
const DIRS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function isTyping(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "range", "button", "submit"].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

/** Remote-style arrow navigation for everything that doesn't handle arrows itself. */
export function useSpatialNav(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key];
      if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (isTyping(active) && (dir === "left" || dir === "right")) return;
      if (active instanceof HTMLInputElement && active.type === "range") return;
      const scope: ParentNode = active?.closest("[data-nav-scope]") ?? document.querySelector("[data-nav-scope]") ?? document;
      const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
        if (el === active) return false;
        if (scope === document && el.closest("[data-nav-scope]")) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      });
      if (!all.length) return;
      if (!active || active === document.body) {
        e.preventDefault();
        (document.querySelector<HTMLElement>("main " + FOCUSABLE) ?? all[0])?.focus();
        return;
      }
      const from = active.getBoundingClientRect();
      const i = pickNext(from, all.map((el) => el.getBoundingClientRect()), dir);
      if (i < 0) return;
      e.preventDefault();
      const target = all[i]!;
      target.focus({ preventScroll: true });
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
