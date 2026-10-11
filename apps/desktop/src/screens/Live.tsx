import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Channel, Group } from "../api";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { VirtualList } from "../components/VirtualList";
import { clock, progressOf, timeRange } from "../lib/time";
import { StreamView } from "../player/StreamView";
import { useApp, type Route } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useDebounced, useGroups, useNow, useNowNext, usePagedChannels } from "../state/hooks";

const ROW = 64;

export function groupLabel(g: Group, all: Group[], sourceName: (id: string) => string): string {
  return all.filter((x) => x.name === g.name).length > 1 ? `${g.name} · ${sourceName(g.sourceId)}` : g.name;
}

export function Live({ route }: { route: Extract<Route, { name: "live" }> }) {
  const { navigate, sources, sourceName } = useApp();
  const groups = useGroups("live");
  const [sel, setSel] = useState<{ groupId: string | null; favorites: boolean }>({ groupId: route.groupId ?? null, favorites: route.favorites ?? false });
  const [filter, setFilter] = useState("");
  const search = useDebounced(filter.trim(), 200);
  const list = usePagedChannels({ groupId: sel.groupId, favoritesOnly: sel.favorites, search });
  const [focused, setFocused] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { menuFor, setFavorite } = useChannelActions();
  const now = useNow(30_000);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setFocused(0), [sel.groupId, sel.favorites, search]);

  const ensure = list.ensure;
  const onRange = useCallback(
    (s: number, e: number) => {
      ensure(s, e);
      setRange((r) => (r[0] === s && r[1] === e ? r : [s, e]));
    },
    [ensure],
  );

  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (let i = range[0]; i < range[1]; i++) {
      const c = list.get(i);
      if (c) ids.push(c.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, list.total, list.get(range[0])?.id, list.get(range[1] - 1)?.id]);
  const nn = useNowNext(visibleIds);

  const current = list.get(focused) ?? null;
  const previewId = useDebounced(current?.id ?? null, 650);

  const ctx = { groupId: sel.favorites ? null : sel.groupId, favoritesOnly: sel.favorites };
  const play = (c: Channel) => navigate({ name: "player", target: { type: "channel", id: c.id }, ctx });

  const multiSource = (sources?.length ?? 0) > 1;
  const bySource = useMemo(() => {
    const m = new Map<string, Group[]>();
    for (const g of groups ?? []) m.set(g.sourceId, [...(m.get(g.sourceId) ?? []), g]);
    return [...m.entries()];
  }, [groups]);

  const pickGroup = (groupId: string | null, favorites: boolean) => {
    setSel({ groupId, favorites });
    navigate({ name: "live", groupId, favorites }, { replace: true });
  };

  return (
    <div className="screen fill live">
      <header className="topbar">
        <h1>Live TV</h1>
        <label className="search-mini">
          <Icon name="search" />
          <input className="input" placeholder="Filter channels" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter channels" />
        </label>
      </header>
      <div className="live-grid">
        <nav className="groups" aria-label="Groups">
          <button type="button" className={sel.favorites ? "group on" : "group"} onClick={() => pickGroup(null, true)}>
            <span>Favorites</span>
            <Icon name="star" />
          </button>
          <button type="button" className={!sel.favorites && !sel.groupId ? "group on" : "group"} onClick={() => pickGroup(null, false)}>
            <span>All channels</span>
          </button>
          {!groups
            ? Array.from({ length: 7 }, (_, i) => <Skeleton key={i} h="2.4rem" r={10} className="group-skel" />)
            : bySource.map(([sid, gs]) => (
                <div key={sid} className="group-sec">
                  {multiSource ? <span className="group-head">{sourceName(sid)}</span> : null}
                  {gs.map((g) => (
                    <button type="button" key={g.id} className={sel.groupId === g.id ? "group on" : "group"} onClick={() => pickGroup(g.id, false)}>
                      <span className="ellipsis">{g.name}</span>
                      <span className="group-count num">{g.itemCount}</span>
                    </button>
                  ))}
                </div>
              ))}
        </nav>

        <div className="chlist" ref={listRef}>
          {list.total === null ? (
            <div className="chlist-skel">
              {Array.from({ length: 9 }, (_, i) => (
                <div className="chrow" key={i}>
                  <Skeleton w="2rem" h="0.8rem" />
                  <Skeleton w="2.6rem" h="2.6rem" r={10} />
                  <div className="chrow-main">
                    <Skeleton w="40%" h="0.9rem" />
                    <Skeleton w="65%" h="0.75rem" />
                  </div>
                </div>
              ))}
            </div>
          ) : list.total === 0 ? (
            <Empty icon={sel.favorites ? "star" : "live"} title={sel.favorites ? "No favorites yet" : search ? "No matching channels" : "No channels in this group"} />
          ) : (
            <VirtualList
              count={list.total}
              rowHeight={ROW}
              focused={focused}
              onFocusChange={setFocused}
              onActivate={(i) => {
                const c = list.get(i);
                if (c) play(c);
              }}
              onRange={onRange}
              label="Channels"
              renderRow={(i, isFocused) => {
                const c = list.get(i);
                if (!c) {
                  return (
                    <div className="chrow">
                      <Skeleton w="2rem" h="0.8rem" />
                      <Skeleton w="2.6rem" h="2.6rem" r={10} />
                      <div className="chrow-main">
                        <Skeleton w="40%" h="0.9rem" />
                      </div>
                    </div>
                  );
                }
                const n = nn[c.id];
                return (
                  <div
                    className={isFocused ? "chrow on" : "chrow"}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c, [{ label: "Watch", icon: "play", onSelect: () => play(c) }]) });
                    }}
                  >
                    <span className="chrow-num num">{c.number}</span>
                    <Logo name={c.name} src={c.logo} />
                    <div className="chrow-main">
                      <b className="ellipsis">
                        {c.name}
                        {c.favorite ? <span className="star-inline" aria-label="Favorite"> ★</span> : null}
                      </b>
                      <span className="ellipsis">{n?.now ? n.now.title : c.epgChannelId ? " " : "No guide"}</span>
                      {n?.now ? <Progress value={progressOf(n.now.start, n.now.stop, now)} className="chrow-bar" /> : null}
                    </div>
                    <span className="chrow-next ellipsis">{n?.next ? `${clock(n.next.start)} ${n.next.title}` : ""}</span>
                  </div>
                );
              }}
            />
          )}
        </div>

        <aside className="live-side">
          <StreamView target={previewId ? { type: "channel", id: previewId } : null} backdrop={current?.name} className="preview" compact />
          {current ? (
            <div className="live-info">
              <div className="live-info-head">
                <Logo name={current.name} src={current.logo} />
                <div>
                  <b>{current.name}</b>
                  <span className="mute num">{current.number} · {current.groupName}</span>
                </div>
              </div>
              {nn[current.id]?.now ? (
                <>
                  <span className="live-tag">Live</span>
                  <h2>{nn[current.id]!.now!.title}</h2>
                  <span className="mute num small">{timeRange(nn[current.id]!.now!.start, nn[current.id]!.now!.stop)}</span>
                  <Progress value={progressOf(nn[current.id]!.now!.start, nn[current.id]!.now!.stop, now)} />
                  {nn[current.id]!.now!.description ? <p className="desc">{nn[current.id]!.now!.description}</p> : null}
                  {nn[current.id]?.next ? (
                    <span className="next-line">
                      <b>Next</b> {clock(nn[current.id]!.next!.start)} · {nn[current.id]!.next!.title}
                    </span>
                  ) : null}
                </>
              ) : null}
              <div className="btns">
                <button type="button" className="btn pri" onClick={() => play(current)}>
                  <Icon name="play" /> Watch
                </button>
                <button type="button" className={current.favorite ? "btn on-star" : "btn"} aria-label={current.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => {
                  void setFavorite(current, !current.favorite);
                  list.patch(current.id, { favorite: !current.favorite });
                }}>
                  <Icon name="star" />
                </button>
                <button type="button" className="btn" aria-label="Multiview" onClick={() => navigate({ name: "multiview", channelId: current.id, ctx })}>
                  <Icon name="grid" />
                </button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
