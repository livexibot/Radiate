import { useMemo, useState } from "react";
import { api, type Channel, type Group, type Programme } from "../api";
import { ChannelCard, EventCard } from "../components/Cards";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Progress } from "../components/Progress";
import { CardRowSkeleton, Skeleton } from "../components/Skeleton";
import { liveSports, onNow, pickHero, startingSoon, type LiveItem } from "../lib/home";
import { monogram, tone } from "../lib/monogram";
import { isSportsGroup } from "../lib/sports";
import { clock, greeting, HOUR, progressOf, timeRange } from "../lib/time";
import { useApp } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useLoad, useNow, useNowNext, useSportsOverrides } from "../state/hooks";

// Bounded so Home stays quick with very large playlists.
const FAVORITES = 40;
const SPORTS_GROUPS = 12;
const PER_SPORTS_GROUP = 24;
const SPORTS_CHANNELS = 160;
const OTHERS = 60;
const SOON = 6 * HOUR;

interface HomeData {
  favorites: Channel[];
  sports: Channel[];
  others: Channel[];
  last: Channel | null;
  epg: Record<string, Programme[]>;
}

export function Home() {
  const { navigate, prefs, version } = useApp();
  const now = useNow(30_000);
  const overrides = useSportsOverrides();
  const { menuFor } = useChannelActions();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data } = useLoad<HomeData>(async () => {
    const groups = await api.groupsList("live", false).catch(() => [] as Group[]);
    const sportsGroups = groups.filter((g) => isSportsGroup(g, overrides)).slice(0, SPORTS_GROUPS);
    const page = (groupId: string, limit: number) => api.channelsList({ groupId, favoritesOnly: false, includeHidden: false, offset: 0, limit }).then((p) => p.items, () => [] as Channel[]);
    const [fav, sportsLists, others, last] = await Promise.all([
      api.channelsList({ favoritesOnly: true, includeHidden: false, offset: 0, limit: FAVORITES }).then((p) => p.items, () => [] as Channel[]),
      Promise.all(sportsGroups.map((g) => page(g.id, PER_SPORTS_GROUP))),
      api.channelsList({ favoritesOnly: false, includeHidden: false, offset: 0, limit: OTHERS }).then((p) => p.items, () => [] as Channel[]),
      prefs?.lastChannelId ? api.channelGet(prefs.lastChannelId).catch(() => null) : Promise.resolve(null),
    ]);
    const sports = sportsLists.flat().slice(0, SPORTS_CHANNELS);
    const at = Date.now();
    const epgIds = [...new Set([...fav, ...sports].map((c) => c.id))];
    const epg = epgIds.length ? await api.epgRange(epgIds, at, at + SOON).catch(() => ({})) : {};
    return { favorites: fav, sports, others, last, epg };
  }, [version, overrides, prefs?.lastChannelId]);

  const ids = useMemo(() => (data ? [...data.favorites, ...data.sports, ...data.others, ...(data.last ? [data.last] : [])].map((c) => c.id) : []), [data]);
  const nn = useNowNext(ids);

  const view = useMemo(() => {
    if (!data) return null;
    const sports = liveSports([...data.favorites, ...data.sports, ...data.others], nn, now, overrides);
    const hero = pickHero(sports, data.favorites, data.others, nn, now, data.last);
    const soon = startingSoon(data.epg, [...data.favorites, ...data.sports], now, SOON);
    const shown = new Set([...sports.map((s) => s.channel.id), ...data.favorites.map((c) => c.id)]);
    const rest = onNow(data.others, nn, now, shown);
    // the hero is already the biggest way in; the row shows the other events
    return { sports: sports.filter((s) => s.channel.id !== hero?.channel.id), hero, soon, rest };
  }, [data, nn, now, overrides]);

  const play = (c: Channel, favoritesOnly = false) =>
    navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: { groupId: favoritesOnly ? null : c.groupId, favoritesOnly } });
  const openMenu = (c: Channel) => (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c) });
  const empty = data && !data.favorites.length && !data.sports.length && !data.others.length;

  return (
    <div className="screen home">
      <header className="topbar">
        <h1>{greeting(now)}</h1>
        <div className="meta">
          <span className="pill num">{clock(now)}</span>
        </div>
      </header>

      {!view ? (
        <Skeleton className="hero" r={18} />
      ) : view.hero ? (
        <Hero item={view.hero} at={now} onPlay={() => play(view.hero!.channel, view.hero!.channel.favorite)} onMulti={() => navigate({ name: "multiview", channelId: view.hero!.channel.id })} />
      ) : empty ? (
        <Empty icon="live" title="No channels yet">
          <button type="button" className="btn pri" onClick={() => navigate({ name: "onboarding" })}>
            Add a source
          </button>
        </Empty>
      ) : null}

      {!view || view.sports.length > 0 ? (
        <Row title="Live sports" onMore={() => navigate({ name: "guide", chip: "sports" })}>
          {!view ? <CardRowSkeleton /> : view.sports.map((it) => <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} live />)}
        </Row>
      ) : null}

      {!data || data.favorites.length > 0 ? (
        <Row title="Favorites">
          {!data ? <CardRowSkeleton /> : data.favorites.map((c) => <ChannelCard key={c.id} channel={c} now={nn[c.id]?.now} at={now} onOpen={() => play(c, true)} onMenu={openMenu(c)} />)}
        </Row>
      ) : null}

      {view && view.soon.length > 0 ? (
        <Row title="Starting soon">
          {view.soon.map((u) => (
            <EventCard key={`${u.channel.id}|${u.programme.start}`} channel={u.channel} programme={u.programme} at={now} onOpen={() => play(u.channel)} onMenu={openMenu(u.channel)} />
          ))}
        </Row>
      ) : null}

      {!view || view.rest.length > 0 ? (
        <Row title="On now">
          {!view ? <CardRowSkeleton /> : view.rest.map((it) => <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} />)}
        </Row>
      ) : null}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function Row({ title, children, onMore }: { title: string; children: React.ReactNode; onMore?: () => void }) {
  return (
    <section className="row">
      <div className="row-head">
        <h2 className="row-title">{title}</h2>
        {onMore ? (
          <button type="button" className="btn small ghost" onClick={onMore}>
            Guide <Icon name="right" />
          </button>
        ) : null}
      </div>
      <div className="cards">{children}</div>
    </section>
  );
}

function Hero({ item, at, onPlay, onMulti }: { item: LiveItem; at: number; onPlay: () => void; onMulti: () => void }) {
  const { channel, now, next } = item;
  const live = !!now && now.start <= at && now.stop > at;
  const mins = now ? Math.max(0, Math.round((at - now.start) / 60_000)) : 0;
  return (
    <section className={`hero ${tone(channel.name)}`} aria-label={channel.name}>
      <span className="hero-mark" aria-hidden="true">{monogram(channel.name)}</span>
      <div className="hero-body">
        {live ? <span className="live-tag">Live · {mins}′</span> : null}
        <h2>{now?.title ?? channel.name}</h2>
        <p>
          {channel.number} · {channel.name}
          {now ? ` · ${timeRange(now.start, now.stop)}` : ""}
          {next ? ` · Next ${clock(next.start)} ${next.title}` : ""}
        </p>
        {now ? <Progress value={progressOf(now.start, now.stop, at)} className="hero-bar" /> : null}
        <div className="btns">
          <button type="button" className="btn pri" onClick={onPlay}>
            <Icon name="play" /> Watch
          </button>
          <button type="button" className="btn" onClick={onMulti}>
            <Icon name="grid" /> Multiview
          </button>
        </div>
      </div>
    </section>
  );
}
