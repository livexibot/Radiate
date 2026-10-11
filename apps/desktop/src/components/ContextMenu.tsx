import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 12), top: Math.min(menu.y, window.innerHeight - r.height - 12) });
    el.querySelector("button")?.focus();
  }, [menu.x, menu.y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);
  return (
    <div className="ctx" role="menu" ref={ref} style={pos} data-nav-scope>
      {menu.items.map((it) => (
        <button
          type="button"
          role="menuitem"
          key={it.label}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
        >
          <Icon name={it.icon} />
          {it.label}
        </button>
      ))}
    </div>
  );
}
