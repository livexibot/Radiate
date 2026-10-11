import { api, type VodItem } from "../api";
import { VodCard } from "../components/Cards";
import { Chips } from "../components/Chips";
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
      <header className="topbar">
        <h1>Library</h1>
        <Chips items={TABS} value={tab} onChange={(id) => navigate({ name: "library", tab: id as LibraryTab }, { replace: true })} label="Library" />
      </header>
      {cont && cont.length > 0 ? (
        <section className="row">
          <h2 className="row-title">Continue watching</h2>
          <div className="cards">
            {cont.map((v) => (
              <VodCard key={v.id} item={v} onOpen={() => open(v)} sub={continueSub(v)} />
            ))}
          </div>
        </section>
      ) : null}
      <div className="library-grid">
        <VodGrid key={tab} kind={tab} />
      </div>
    </div>
  );
}
