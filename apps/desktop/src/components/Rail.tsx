import { useApp, type Route } from "../state/app";
import { Icon, type IconName } from "./Icon";
import { UpdatePill } from "../updater";

const ITEMS: { route: Route["name"]; icon: IconName; label: string; key: string }[] = [
  { route: "home", icon: "home", label: "Home", key: "H" },
  { route: "live", icon: "live", label: "Live TV", key: "L" },
  { route: "guide", icon: "guide", label: "Guide", key: "G" },
  { route: "search", icon: "search", label: "Search", key: "/" },
  { route: "library", icon: "film", label: "Library", key: "B" },
  { route: "settings", icon: "gear", label: "Settings", key: "Ctrl+," },
];

const OWNER: Partial<Record<Route["name"], Route["name"]>> = { movies: "library", series: "library", movie: "library", seriesDetail: "library" };

export function Rail() {
  const { route, navigate } = useApp();
  const active = OWNER[route.name] ?? route.name;
  return (
    <nav className="rail" aria-label="Main">
      <div className="rail-logo" aria-hidden="true">R</div>
      {ITEMS.map((it) => (
        <button
          key={it.route}
          type="button"
          className={active === it.route ? "rail-btn on" : "rail-btn"}
          aria-label={it.label}
          aria-current={active === it.route ? "page" : undefined}
          title={`${it.label} (${it.key})`}
          onClick={() => navigate({ name: it.route } as Route)}
        >
          <Icon name={it.icon} />
          <span className="rail-tip">{it.label}</span>
        </button>
      ))}
      <div className="rail-end">
        <UpdatePill />
      </div>
    </nav>
  );
}
