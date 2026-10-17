import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ContentKind, type VodItem } from "../api";
import { Poster } from "../components/Cards";
import { Chips } from "../components/Chips";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Skeleton } from "../components/Skeleton";
import { useApp } from "../state/app";
import { useDebounced, useGroups } from "../state/hooks";
import { groupLabel } from "./Live";

const PAGE = 60;

export function VodGrid({ kind }: { kind: Extract<ContentKind, "movie" | "series"> }) {
  const { navigate, version, sourceName } = useApp();
  const groups = useGroups(kind);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const search = useDebounced(q.trim(), 250);
  const [items, setItems] = useState<VodItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setTotal(null);
    setItems([]);
    api.vodList({ kind, groupId: group === "all" ? null : group, search: search || null, offset: 0, limit: PAGE }).then(
      (p) => {
        if (g !== gen.current) return;
        setItems(p.items);
        setTotal(p.total);
      },
      () => g === gen.current && setTotal(0),
    );
  }, [kind, group, search, version]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || loadingMore || total === null || items.length >= total) return;
      const g = gen.current;
      setLoadingMore(true);
      api.vodList({ kind, groupId: group === "all" ? null : group, search: search || null, offset: items.length, limit: PAGE }).then(
        (p) => {
          if (g === gen.current) setItems((x) => [...x, ...p.items]);
          setLoadingMore(false);
        },
        () => setLoadingMore(false),
      );
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, total, loadingMore, kind, group, search]);

  const chips = useMemo(() => [{ id: "all", label: "All" }, ...(groups ?? []).map((g) => ({ id: g.id, label: groupLabel(g, groups ?? [], sourceName) }))], [groups, sourceName]);
  const title = kind === "movie" ? "Movies" : "Series";

  return (
    <section className="vod" aria-label={title}>
      <div className="vod-bar">
        <Chips items={chips} value={group} onChange={setGroup} label="Groups" />
        <label className="search-mini">
          <Icon name="search" />
          <input className="input" placeholder={`Search ${title.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${title.toLowerCase()}`} />
        </label>
      </div>
      {total === null ? (
        <div className="posters">
          {Array.from({ length: 14 }, (_, i) => (
            <div className="poster" key={i}>
              <Skeleton className="poster-art" r={14} />
              <Skeleton w="70%" h="0.85rem" />
            </div>
          ))}
        </div>
      ) : total === 0 ? (
        <Empty icon={kind === "movie" ? "film" : "series"} title={search ? `Nothing matches "${search}"` : `No ${title.toLowerCase()} in your sources`} />
      ) : (
        <div className="posters">
          {items.map((it) => (
            <Poster key={it.id} item={it} onOpen={() => navigate(kind === "movie" ? { name: "movie", id: it.id } : { name: "seriesDetail", id: it.id })} />
          ))}
        </div>
      )}
      <div ref={sentinel} className="sentinel" />
    </section>
  );
}
