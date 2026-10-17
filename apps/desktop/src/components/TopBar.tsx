import { clock } from "../lib/time";
import { useNow } from "../state/hooks";
import { useApp, type Route } from "../state/app";
import { UpdatePill } from "../updater";
import { Icon, type IconName } from "./Icon";

interface Item {
  route: "home" | "search" | "favorites" | "live" | "guide" | "settings";
  icon: IconName;
  label: string;
  key: string;
}

/** Two clusters, centred: what to watch, then where to find it. */
const NAV: Item[][] = [
  [
    { route: "home", icon: "home", label: "Home", key: "H" },
    { route: "search", icon: "search", label: "Search", key: "/" },
    { route: "favorites", icon: "star", label: "Favorites", key: "F" },
  ],
  [
    { route: "live", icon: "live", label: "Live TV", key: "L" },
    { route: "guide", icon: "guide", label: "Guide", key: "G" },
    { route: "settings", icon: "gear", label: "Settings", key: "Ctrl+," },
  ],
];

export function TopBar() {
  const { route, navigate } = useApp();
  const now = useNow(15_000);
  return (
    <header className="appbar">
      <div className="appbar-start">
        <span className="brand-mark" aria-hidden="true">R</span>
      </div>
      <nav className="appbar-nav" aria-label="Main">
        {NAV.map((cluster, i) => (
          <div className="appbar-cluster" key={i}>
            {i > 0 ? <span className="appbar-sep" aria-hidden="true" /> : null}
            {cluster.map((it) => {
              const on = route.name === it.route;
              return (
                <button
                  key={it.route}
                  type="button"
                  className={on ? "appbar-item on" : "appbar-item"}
                  aria-current={on ? "page" : undefined}
                  title={`${it.label} (${it.key})`}
                  onClick={() => navigate({ name: it.route } as Route)}
                >
                  <Icon name={it.icon} />
                  <span>{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="appbar-end">
        <UpdatePill />
        <span className="appbar-clock num" aria-label={`Time ${clock(now)}`}>
          {clock(now)}
        </span>
      </div>
    </header>
  );
}
