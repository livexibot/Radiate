import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type Channel, type SearchResults, type VodItem } from "../api";
import { Chips } from "../components/Chips";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { tone } from "../lib/monogram";
import { clock, dayLabel, progressOf, timeRange } from "../lib/time";
import { useApp } from "../state/app";
import { useDebounced, useNow } from "../state/hooks";

type Filter = "all" | "channels" | "live" | "upcoming" | "movies" | "series";

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function Search({ initial }: { initial?: string }) {
  const { navigate, toast } = useApp();
  const [q, setQ] = useState(initial ?? "");
  const query = useDebounced(q.trim(), 250);
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!query) {
      setRes(null);
      return;
    }
    let alive = true;
    setLoading(true);
    api.searchAll(query, 12).then(
      (r) => {
        if (!alive) return;
        setRes(r);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setLoading(false);
        toast(errorMessage(e), "bad");
      },
    );
    return () => {
      alive = false;
    };
  }, [query, toast]);

  const playChannel = (c: Channel) => navigate({ name: "player", target: { type: "channel", id: c.id }, ctx: { groupId: c.groupId, favoritesOnly: false } });
  const openVod = (v: VodItem) => navigate(v.kind === "series" ? { name: "seriesDetail", id: v.id } : { name: "movie", id: v.id });
  const show = (f: Filter) => filter === "all" || filter === f;
  const counts = res ? { channels: res.channels.length, live: res.liveNow.length, upcoming: res.upcoming.length, movies: res.movies.length, series: res.series.length } : null;
  const nothing = res && counts && Object.values(counts).every((n) => n === 0);

  const chips = [
    { id: "all", label: "All" },
    { id: "channels", label: `Channels${counts ? ` ${counts.channels}` : ""}` },
    { id: "live", label: `On now${counts ? ` ${counts.live}` : ""}` },
    { id: "upcoming", label: `Upcoming${counts ? ` ${counts.upcoming}` : ""}` },
    { id: "movies", label: `Movies${counts ? ` ${counts.movies}` : ""}` },
    { id: "series", label: `Series${counts ? ` ${counts.series}` : ""}` },
  ];

  return (
    <div className="screen search">
      <header className="topbar">
        <h1>Search</h1>
      </header>
      <label className="search-big">
        <Icon name="search" />
        <input ref={inputRef} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Channels, shows, movies, series" aria-label="Search" spellCheck={false} />
        {q ? (
          <button type="button" className="icon-btn" aria-label="Clear" onClick={() => { setQ(""); inputRef.current?.focus(); }}>
            <Icon name="close" />
          </button>
        ) : null}
      </label>
      {res ? (
        <div className="search-chips">
          <Chips items={chips} value={filter} onChange={(f) => setFilter(f as Filter)} label="Result types" />
        </div>
      ) : null}

      {!query ? (
        <Empty icon="search" title="Search everything" />
      ) : loading && !res ? (
        <div className="results">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} h="3.6rem" r={12} />
          ))}
        </div>
      ) : nothing ? (
        <Empty icon="search" title={`Nothing matches "${query}"`} />
      ) : res ? (
        <div className="results">
          {show("live") && res.liveNow.length > 0 ? (
            <Section title="On now">
              {res.liveNow.map(({ channel, programme }) => (
                <button type="button" className="res" key={`${channel.id}${programme.start}`} onClick={() => playChannel(channel)}>
                  <Logo name={channel.name} src={channel.logo} />
                  <span className="res-main">
                    <b className="ellipsis"><Mark text={programme.title} q={query} /></b>
                    <span className="ellipsis">{channel.name} · {timeRange(programme.start, programme.stop)}</span>
                    <Progress value={progressOf(programme.start, programme.stop, now)} className="res-bar" />
                  </span>
                  <span className="live-tag">Live</span>
                </button>
              ))}
            </Section>
          ) : null}
          {show("channels") && res.channels.length > 0 ? (
            <Section title="Channels">
              {res.channels.map((c) => (
                <button type="button" className="res" key={c.id} onClick={() => playChannel(c)}>
                  <Logo name={c.name} src={c.logo} />
                  <span className="res-main">
                    <b className="ellipsis"><Mark text={c.name} q={query} /></b>
                    <span className="ellipsis num">{c.number} · {c.groupName}</span>
                  </span>
                  {c.favorite ? <span className="star-inline">★</span> : null}
                </button>
              ))}
            </Section>
          ) : null}
          {show("upcoming") && res.upcoming.length > 0 ? (
            <Section title="Upcoming">
              {res.upcoming.map(({ channel, programme }) => (
                <button type="button" className="res" key={`${channel.id}${programme.start}`} onClick={() => playChannel(channel)}>
                  <Logo name={channel.name} src={channel.logo} />
                  <span className="res-main">
                    <b className="ellipsis"><Mark text={programme.title} q={query} /></b>
                    <span className="ellipsis">{channel.name} · {dayLabel(programme.start, now)} {clock(programme.start)}</span>
                  </span>
                </button>
              ))}
            </Section>
          ) : null}
          {show("movies") && res.movies.length > 0 ? (
            <Section title="Movies">
              {res.movies.map((v) => <VodRow key={v.id} v={v} q={query} onOpen={() => openVod(v)} />)}
            </Section>
          ) : null}
          {show("series") && res.series.length > 0 ? (
            <Section title="Series">
              {res.series.map((v) => <VodRow key={v.id} v={v} q={query} onOpen={() => openVod(v)} />)}
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="res-sec">
      <h2>{title}</h2>
      <div className="res-list">{children}</div>
    </section>
  );
}

function VodRow({ v, q, onOpen }: { v: VodItem; q: string; onOpen: () => void }) {
  return (
    <button type="button" className="res" onClick={onOpen}>
      <span className={`res-poster ${tone(v.name)}`} aria-hidden="true" />
      <span className="res-main">
        <b className="ellipsis"><Mark text={v.name} q={q} /></b>
        <span className="ellipsis">{[v.year, v.groupName].filter(Boolean).join(" · ")}</span>
        {v.progress ? <Progress value={v.progress} className="res-bar" /> : null}
      </span>
      {v.rating ? <span className="res-rt">★ {v.rating.toFixed(1)}</span> : null}
    </button>
  );
}
