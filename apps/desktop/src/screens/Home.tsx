import { useMemo, useState } from "react";
import { api, type Channel, type Group, type Programme, type VodItem } from "../api";
import { ChannelCard, EventCard, VodCard } from "../components/Cards";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { Icon, type IconName } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Progress } from "../components/Progress";
import { CardSkeletons, Skeleton } from "../components/Skeleton";
import { liveSports, onNow, pickHero, startingSoon, type LiveItem } from "../lib/home";
import { monogram, tone } from "../lib/monogram";
import { isSportsGroup } from "../lib/sports";
import { clock, HOUR, progressOf, timeRange } from "../lib/time";
import { useApp, type Route } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useLoad, useNow, useNowNext, useSportsOverrides } from "../state/hooks";
import { continueSub } from "./Library";

// Bounded so Home stays quick with very large playlists.
const FAVORITES = 40;
const SPORTS_GROUPS = 12;
const PER_SPORTS_GROUP = 24;
const SPORTS_CHANNELS = 160;
const OTHERS = 60;
const CONTINUE = 12;
const SOON = 6 * HOUR;

interface HomeData {
  favorites: Channel[];
  sports: Channel[];
  others: Channel[];
  last: Channel | null;
  epg: Record<string, Programme[]>;
  cont: VodItem[];
}

export function Home() {
  const { navigate, prefs, version, sources } = useApp();
  const now = useNow(30_000);
  const overrides = useSportsOverrides();
  const { menuFor } = useChannelActions();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data } = useLoad<HomeData>(async () => {
    const groups = await api.groupsList("live", false).catch(() => [] as Group[]);
    const sportsGroups = groups.filter((g) => isSportsGroup(g, overrides)).slice(0, SPORTS_GROUPS);
    const page = (groupId: string, limit: number) => api.channelsList({ groupId, favoritesOnly: false, includeHidden: false, offset: 0, limit }).then((p) => p.items, () => [] as Channel[]);
    const [fav, sportsLists, others, last, cont] = await Promise.all([
      api.channelsList({ favoritesOnly: true, includeHidden: false, offset: 0, limit: FAVORITES }).then((p) => p.items, () => [] as Channel[]),
      Promise.all(sportsGroups.map((g) => page(g.id, PER_SPORTS_GROUP))),
      api.channelsList({ favoritesOnly: false, includeHidden: false, offset: 0, limit: OTHERS }).then((p) => p.items, () => [] as Channel[]),
      prefs?.lastChannelId ? api.channelGet(prefs.lastChannelId).catch(() => null) : Promise.resolve(null),
      api.continueWatching(CONTINUE).catch(() => [] as VodItem[]),
    ]);
    const sports = sportsLists.flat().slice(0, SPORTS_CHANNELS);
    const at = Date.now();
    const epgIds = [...new Set([...fav, ...sports].map((c) => c.id))];
    const epg = epgIds.length ? await api.epgRange(epgIds, at, at + SOON).catch(() => ({})) : {};
    return { favorites: fav, sports, others, last, epg, cont };
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
  const openVod = (v: VodItem) => navigate(v.kind === "series" ? { name: "seriesDetail", id: v.seriesId ?? v.id } : { name: "movie", id: v.id });
  const openMenu = (c: Channel) => (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c) });
  const empty = data && !data.favorites.length && !data.sports.length && !data.others.length;
  const hasMovies = !!sources?.some((s) => s.movieCount > 0);
  const hasSeries = !!sources?.some((s) => s.seriesCount > 0);

  return (
    <div className="screen home">
      <h1 className="sr-only">Home</h1>

      {!view ? (
        <Skeleton className="hero" r={24} />
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
        <Row title="Live sports" size="lg" live more={{ label: "Guide", onClick: () => navigate({ name: "guide", chip: "sports" }) }}>
          {!view ? <CardSkeletons /> : view.sports.map((it) => <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} live />)}
        </Row>
      ) : null}

      {!data || data.favorites.length > 0 ? (
        <Row title="Favorites" more={{ label: "All", onClick: () => navigate({ name: "favorites" }) }}>
          {!data ? <CardSkeletons /> : data.favorites.map((c) => <ChannelCard key={c.id} channel={c} now={nn[c.id]?.now} at={now} onOpen={() => play(c, true)} onMenu={openMenu(c)} />)}
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
        <Row title="On now" more={{ label: "Live TV", onClick: () => navigate({ name: "live" }) }}>
          {!view ? <CardSkeletons /> : view.rest.map((it) => <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} />)}
        </Row>
      ) : null}

      {data && (hasMovies || hasSeries || data.cont.length > 0) ? (
        <Row title="Movies & series">
          {hasMovies ? <Shortcut icon="film" label="Movies" route={{ name: "library", tab: "movie" }} /> : null}
          {hasSeries ? <Shortcut icon="series" label="Series" route={{ name: "library", tab: "series" }} /> : null}
          {data.cont.map((v) => (
            <VodCard key={v.id} item={v} onOpen={() => openVod(v)} sub={continueSub(v)} />
          ))}
        </Row>
      ) : null}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function Row({ title, children, more, size, live }: { title: string; children: React.ReactNode; more?: { label: string; onClick: () => void }; size?: "lg"; live?: boolean }) {
  return (
    <section className="row">
      <div className="row-head">
        <h2 className={live ? "row-title live" : "row-title"}>{title}</h2>
        {more ? (
          <button type="button" className="row-more" onClick={more.onClick}>
            {more.label}
            <Icon name="right" />
          </button>
        ) : null}
      </div>
      <div className={size ? `cards ${size}` : "cards"}>{children}</div>
    </section>
  );
}

function Shortcut({ icon, label, route }: { icon: IconName; label: string; route: Route }) {
  const { navigate } = useApp();
  return (
    <button type="button" className="card shortcut" onClick={() => navigate(route)}>
      <span className="shortcut-ico">
        <Icon name={icon} />
      </span>
      <b>{label}</b>
    </button>
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
        <div className="hero-kicker">
          {live ? (
            <span className="live-pill">
              Live <span className="num">{mins}′</span>
            </span>
          ) : null}
          {channel.logo ? <Logo name={channel.name} src={channel.logo} className="hero-logo" /> : null}
          <span className="hero-channel">
            <span className="num">{channel.number}</span> {channel.name}
          </span>
        </div>
        <h2>{now?.title ?? channel.name}</h2>
        {now ? (
          <div className="hero-time">
            <span className="num">{timeRange(now.start, now.stop)}</span>
            <Progress value={progressOf(now.start, now.stop, at)} className="hero-bar" />
          </div>
        ) : null}
        {next ? (
          <p className="hero-next">
            <b>Next</b> <span className="num">{clock(next.start)}</span> {next.title}
          </p>
        ) : null}
        <div className="btns">
          <button type="button" className="btn pri lg" onClick={onPlay}>
            <Icon name="play" /> Watch
          </button>
          <button type="button" className="btn lg" onClick={onMulti}>
            <Icon name="grid" /> Multiview
          </button>
        </div>
      </div>
    </section>
  );
}
