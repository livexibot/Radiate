import { useMemo, useState } from "react";
import { api, type Channel, type Programme } from "../api";
import { ChannelCard, EventCard } from "../components/Cards";
import { ContextMenu, type MenuState } from "../components/ContextMenu";
import { Empty } from "../components/Empty";
import { CardSkeletons } from "../components/Skeleton";
import { favoritesView, startingSoon } from "../lib/home";
import { HOUR } from "../lib/time";
import { useApp } from "../state/app";
import { useChannelActions } from "../state/channelActions";
import { useLoad, useNow, useNowNext, useSportsOverrides } from "../state/hooks";

// Bounded so the screen stays quick for someone who stars half their playlist.
const MAX = 400;
const EPG_FOR = 160;
const SOON = 6 * HOUR;

interface FavData {
  channels: Channel[];
  epg: Record<string, Programme[]>;
}

export function Favorites() {
  const { navigate, version } = useApp();
  const now = useNow(30_000);
  const overrides = useSportsOverrides();
  const { menuFor } = useChannelActions();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data } = useLoad<FavData>(async () => {
    const channels = await api.channelsList({ favoritesOnly: true, includeHidden: false, offset: 0, limit: MAX }).then((p) => p.items, () => [] as Channel[]);
    const at = Date.now();
    const ids = channels.slice(0, EPG_FOR).map((c) => c.id);
    const epg = ids.length ? await api.epgRange(ids, at, at + SOON).catch(() => ({})) : {};
    return { channels, epg };
  }, [version]);

  const ids = useMemo(() => data?.channels.map((c) => c.id) ?? [], [data]);
  const nn = useNowNext(ids);
  const view = useMemo(() => (data ? { ...favoritesView(data.channels, nn, now, overrides), soon: startingSoon(data.epg, data.channels, now, SOON) } : null), [data, nn, now, overrides]);

  // zapping from here stays inside favorites
  const play = (c: Channel) => navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: { groupId: null, favoritesOnly: true } });
  const openMenu = (c: Channel) => (e: React.MouseEvent) => setMenu({ x: e.clientX, y: e.clientY, items: menuFor(c) });

  return (
    <div className="screen favorites">
      <h1 className="sr-only">Favorites</h1>
      {!view ? (
        <Section title="On now">
          <CardSkeletons count={8} />
        </Section>
      ) : data && data.channels.length === 0 ? (
        <Empty icon="star" title="No favorites yet">
          <button type="button" className="btn pri" onClick={() => navigate({ name: "live" })}>
            Live TV
          </button>
          <button type="button" className="btn" onClick={() => navigate({ name: "guide" })}>
            Guide
          </button>
        </Empty>
      ) : (
        <>
          {view.sports.length > 0 ? (
            <Section title="Live sports" count={view.sports.length} size="lg">
              {view.sports.map((it) => (
                <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} live />
              ))}
            </Section>
          ) : null}
          {view.onNow.length > 0 ? (
            <Section title="On now" count={view.onNow.length}>
              {view.onNow.map((it) => (
                <ChannelCard key={it.channel.id} channel={it.channel} now={it.now} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} />
              ))}
            </Section>
          ) : null}
          {view.soon.length > 0 ? (
            <Section title="Starting soon" count={view.soon.length}>
              {view.soon.map((u) => (
                <EventCard key={`${u.channel.id}|${u.programme.start}`} channel={u.channel} programme={u.programme} at={now} onOpen={() => play(u.channel)} onMenu={openMenu(u.channel)} />
              ))}
            </Section>
          ) : null}
          {view.other.length > 0 ? (
            <Section title="Off air" count={view.other.length}>
              {view.other.map((it) => (
                <ChannelCard key={it.channel.id} channel={it.channel} now={null} at={now} onOpen={() => play(it.channel)} onMenu={openMenu(it.channel)} />
              ))}
            </Section>
          ) : null}
        </>
      )}
      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function Section({ title, count, size, children }: { title: string; count?: number; size?: "lg"; children: React.ReactNode }) {
  return (
    <section className="row">
      <div className="row-head">
        <h2 className="row-title">
          {title}
          {count !== undefined ? <span className="row-count num">{count}</span> : null}
        </h2>
      </div>
      <div className={size ? `card-grid ${size}` : "card-grid"}>{children}</div>
    </section>
  );
}
