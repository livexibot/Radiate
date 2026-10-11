import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { clampIndex, computeWindow, scrollToReveal } from "../lib/virtual";

interface Props {
  count: number;
  rowHeight: number;
  renderRow: (index: number, focused: boolean) => ReactNode;
  focused: number;
  onFocusChange: (i: number) => void;
  onActivate?: (i: number) => void;
  onRange?: (start: number, end: number) => void;
  label: string;
  className?: string;
  overscan?: number;
}

/** Fixed-row-height windowed list with keyboard focus. Only visible rows are in the DOM. */
export function VirtualList({ count, rowHeight, renderRow, focused, onFocusChange, onActivate, onRange, label, className = "", overscan = 6 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const win = computeWindow({ scrollTop, viewport, rowHeight, count, overscan });

  useEffect(() => {
    onRange?.(win.start, win.end);
  }, [win.start, win.end, onRange]);

  const reveal = useCallback(
    (i: number) => {
      const el = ref.current;
      if (!el) return;
      const next = scrollToReveal(i, el.scrollTop, el.clientHeight, rowHeight);
      if (next !== el.scrollTop) el.scrollTop = next;
    },
    [rowHeight],
  );

  useEffect(() => {
    if (document.activeElement === ref.current) reveal(focused);
  }, [focused, reveal]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = focused + 1;
    else if (e.key === "ArrowUp") {
      if (focused === 0) return; // let spatial navigation leave the list upwards
      next = focused - 1;
    } else if (e.key === "PageDown") next = focused + page;
    else if (e.key === "PageUp") next = focused - page;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "Enter" && onActivate) {
      e.preventDefault();
      onActivate(focused);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const c = clampIndex(next, count);
    onFocusChange(c);
    reveal(c);
  };

  const rows: ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    rows.push(
      <div
        key={i}
        className={i === focused ? "vrow focused" : "vrow"}
        style={{ top: i * rowHeight, height: rowHeight }}
        role="option"
        aria-selected={i === focused}
        onMouseDown={() => onFocusChange(i)}
        onDoubleClick={() => onActivate?.(i)}
      >
        {renderRow(i, i === focused)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className={`vlist ${className}`}
      tabIndex={0}
      role="listbox"
      aria-label={label}
      aria-activedescendant={undefined}
      data-nav="self"
      onKeyDown={onKey}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="vlist-inner" style={{ height: win.totalHeight }}>
        {rows}
      </div>
    </div>
  );
}
