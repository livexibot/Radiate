import { useMemo, useState } from "react";
import { api, type Channel, type Programme, type VodItem } from "../api";
import { ChannelCard, VodCard } from "../components/Cards";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Progress } from "../components/Progress";
import { CardRowSkeleton, Skeleton } from "../components/Skeleton";
import { monogram, tone } from "../lib/monogram";
import { clock, greeting, progressOf, timeRange } from "../lib/time";
import { useApp } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useLoad, useNow, useNowNext } from "../state/hooks";

interface HomeData {
  favorites: Channel[];
  onNow: Channel[];
  recent: Channel[];
  vod: VodItem[];
}

export function Home() {
  const { navigate, prefs, version } = useApp();
  const now = useNow(30_000);
  const { menuFor } = useChannelActions();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data } = useLoad<HomeData>(async () => {
    const [fav, all, vod] = await Promise.all([
      api.channelsList({ favoritesOnly: true, includeHidden: false, offset: 0, limit: 30 }),
      api.channelsList({ favoritesOnly: false, includeHidden: false, offset: 0, limit: 60 }),
      api.continueWatching(12).catch(() => [] as VodItem[]),
    ]);
    const recentIds = [prefs?.lastChannelId, prefs?.previousChannelId].filter((x): x is string => !!x);
    const recent = (await Promise.all(recentIds.map((id) => api.channelGet(id).catch(() => null)))).filter((c): c is Channel => !!c);
    const favIds = new Set(fav.items.map((c) => c.id));
    return { favorites: fav.items, onNow: all.items.filter((c) => !favIds.has(c.id)).slice(0, 24), recent, vod };
  }, [version, prefs?.lastChannelId, prefs?.previousChannelId]);

  const ids = useMemo(() => (data ? [...data.favorites, ...data.onNow, ...data.recent].map((c) => c.id) : []), [data]);
  const nn = useNowNext(ids);

  const hero = useMemo(() => {
    if (!data) return null;
    const live = data.favorites.find((c) => nn[c.id]?.now);
    const pick = live ?? data.recent[0] ?? data.favorites[0] ?? data.onNow.find((c) => nn[c.id]?.now) ?? data.onNow[0];
    return pick ? { channel: pick, now: nn[pick.id]?.now ?? null, next: nn[pick.id]?.next ?? null } : null;
  }, [data, nn]);

  const play = (c: Channel, favoritesOnly = false) =>
    navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: { groupId: favoritesOnly ? null : c.groupId, favoritesOnly } });
  const openMenu = (c: Channel) => (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c) });
  const openVod = (v: VodItem) => navigate(v.kind === "series" ? { name: "seriesDetail", id: v.id } : { name: "movie", id: v.id });

  return (
    <div className="screen home">
      <header className="topbar">
        <h1>{greeting(now)}</h1>
        <div className="meta">
          <span className="pill num">{clock(now)}</span>
        </div>
      </header>

      {!data ? (
        <Skeleton className="hero" r={18} />
      ) : hero ? (
        <Hero channel={hero.channel} now={hero.now} next={hero.next} at={now} onPlay={() => play(hero.channel, hero.channel.favorite)} onMulti={() => navigate({ name: "multiview", channelId: hero.channel.id })} onGuide={() => navigate({ name: "guide" })} />
      ) : (
        <Empty icon="live" title="No channels yet">
          <button type="button" className="btn pri" onClick={() => navigate({ name: "onboarding" })}>
            Add a source
          </button>
        </Empty>
      )}

      {(!data || data.recent.length > 0 || data.vod.length > 0) && (
        <Row title="Continue watching">
          {!data ? (
            <CardRowSkeleton />
          ) : (
            <>
              {data.recent.map((c) => (
                <ChannelCard key={c.id} channel={c} now={nn[c.id]?.now} at={now} onOpen={() => play(c)} onMenu={openMenu(c)} />
              ))}
              {data.vod.map((v) => (
                <VodCard key={v.id} item={v} onOpen={() => openVod(v)} sub={v.kind === "series" ? "Series" : v.progress ? `${Math.round(v.progress * 100)}% watched` : "Movie"} />
              ))}
            </>
          )}
        </Row>
      )}

      {(!data || data.favorites.length > 0) && (
        <Row title="Favorites">
          {!data ? <CardRowSkeleton /> : data.favorites.map((c) => <ChannelCard key={c.id} channel={c} now={nn[c.id]?.now} at={now} onOpen={() => play(c, true)} onMenu={openMenu(c)} />)}
        </Row>
      )}

      <Row title="On now">
        {!data ? <CardRowSkeleton /> : data.onNow.map((c) => <ChannelCard key={c.id} channel={c} now={nn[c.id]?.now} at={now} onOpen={() => play(c)} onMenu={openMenu(c)} />)}
      </Row>
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="row">
      <h2 className="row-title">{title}</h2>
      <div className="cards">{children}</div>
    </section>
  );
}

function Hero({ channel, now, next, at, onPlay, onMulti, onGuide }: { channel: Channel; now: Programme | null; next: Programme | null; at: number; onPlay: () => void; onMulti: () => void; onGuide: () => void }) {
  const mins = now ? Math.max(0, Math.round((at - now.start) / 60_000)) : 0;
  return (
    <section className={`hero ${tone(channel.name)}`} aria-label={channel.name}>
      <span className="hero-mark" aria-hidden="true">{monogram(channel.name)}</span>
      <div className="hero-body">
        {now ? <span className="live-tag">Live · {mins}′</span> : null}
        <h2>{now?.title ?? channel.name}</h2>
        <p>
          {channel.number} · {channel.name}
          {now ? ` · ${timeRange(now.start, now.stop)}` : ""}
          {next ? ` · Next ${clock(next.start)} ${next.title}` : ""}
        </p>
        {now ? <Progress value={progressOf(now.start, now.stop, at)} className="hero-bar" /> : null}
        <div className="btns">
          <button type="button" className="btn pri" onClick={onPlay}>
            <Icon name="play" /> Watch live
          </button>
          <button type="button" className="btn" onClick={onGuide}>
            <Icon name="guide" /> Guide
          </button>
          <button type="button" className="btn" onClick={onMulti}>
            <Icon name="grid" /> Multiview
          </button>
        </div>
      </div>
    </section>
  );
}
