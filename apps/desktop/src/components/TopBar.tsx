import { clock } from "../lib/time";
import { useNow } from "../state/hooks";
import { useAppearance } from "../plugins/host";
import { useApp, type Route } from "../state/app";
import { UpdatePill } from "../updater";
import { useRecordings } from "../state/recordings";
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
  const { layout } = useAppearance();
  const now = useNow(15_000);
  if (layout.nav === "rail") return <SideRail />;
  return (
    <header className="appbar" data-ui="nav">
      <div className="appbar-start" aria-hidden="true">
        <span className="brand-mark">R</span>
        <span className="brand-name">Radiate</span>
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
        <RecPill />
        <UpdatePill />
        <span className="appbar-clock num" aria-label={`Time ${clock(now)}`}>
          {clock(now)}
        </span>
      </div>
    </header>
  );
}

/** Shown while anything records; opens Settings › Recordings. */
function RecPill() {
  const { navigate } = useApp();
  const running = useRecordings();
  if (!running.length) return null;
  return (
    <button type="button" className="rec-pill" title={running.map((r) => r.title).join(", ")} onClick={() => navigate({ name: "settings", section: "recordings" })}>
      <span className="rec-dot" aria-hidden />
      REC{running.length > 1 ? <span className="num"> {running.length}</span> : null}
    </button>
  );
}

/** The same destinations down the left edge (layouts with `nav: "rail"`). */
function SideRail() {
  const { route, navigate } = useApp();
  const now = useNow(15_000);
  return (
    <header className="apprail" data-ui="nav">
      <span className="brand-mark" aria-hidden="true">R</span>
      <nav className="apprail-nav" aria-label="Main">
        {NAV.map((cluster, i) => (
          <div className="apprail-cluster" key={i}>
            {i > 0 ? <span className="apprail-sep" aria-hidden="true" /> : null}
            {cluster.map((it) => {
              const on = route.name === it.route;
              return (
                <button
                  key={it.route}
                  type="button"
                  className={on ? "apprail-item on" : "apprail-item"}
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
      <div className="apprail-end">
        <RecPill />
        <UpdatePill />
        <span className="appbar-clock num" aria-label={`Time ${clock(now)}`}>
          {clock(now)}
        </span>
      </div>
    </header>
  );
}
