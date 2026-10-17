import { api, type VodItem } from "../api";
import { VodCard } from "../components/Cards";
import { useApp, type LibraryTab } from "../state/app";
import { useLoad } from "../state/hooks";
import { VodGrid } from "./VodGrid";

const TABS = [
  { id: "movie", label: "Movies" },
  { id: "series", label: "Series" },
];

export function continueSub(v: VodItem): string {
  if (v.kind === "series") return v.season != null && v.episode != null ? `S${v.season} · E${v.episode}` : "Series";
  return v.progress ? `${Math.round(v.progress * 100)}% watched` : "Movie";
}

export function Library({ tab }: { tab: LibraryTab }) {
  const { navigate, version } = useApp();
  const { data: cont } = useLoad<VodItem[]>(() => api.continueWatching(12).catch(() => []), [version]);
  const open = (v: VodItem) => navigate(v.kind === "series" ? { name: "seriesDetail", id: v.seriesId ?? v.id } : { name: "movie", id: v.id });

  return (
    <div className="screen library">
      <h1 className="sr-only">{tab === "movie" ? "Movies" : "Series"}</h1>
      <div className="page-tabs" role="tablist" aria-label="Library">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={t.id === tab ? "page-tab on" : "page-tab"}
            onClick={() => navigate({ name: "library", tab: t.id as LibraryTab }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {cont && cont.length > 0 ? (
        <section className="row">
          <div className="row-head">
            <h2 className="row-title">Continue watching</h2>
          </div>
          <div className="cards">
            {cont.map((v) => (
              <VodCard key={v.id} item={v} onOpen={() => open(v)} sub={continueSub(v)} />
            ))}
          </div>
        </section>
      ) : null}
      <VodGrid key={tab} kind={tab} />
    </div>
  );
}
