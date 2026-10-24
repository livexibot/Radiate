import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, type AppInfo, type Channel, type Group, type Source } from "../api";
import { pickOpenFile, pickSaveFile } from "../api/dialogs";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Modal } from "../components/Modal";
import { Skeleton } from "../components/Skeleton";
import { ago, DAY, shortDate } from "../lib/time";
import { useApp, type SettingsSection } from "../state/app";
import { isSportsGroup, toggleSportsGroup } from "../lib/sports";
import { useLoad, useSportsOverrides } from "../state/hooks";
import { ReactorList } from "../reactor/ReactorList";
import { UpdateSection } from "../updater";
import { EpgMatchPicker } from "./EpgMatchPicker";

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "sources", label: "Sources & guides" },
  { id: "channels", label: "Channels & groups" },
  { id: "playback", label: "Playback" },
  { id: "reactors", label: "Reactors" },
  { id: "backup", label: "Backup" },
  { id: "about", label: "About" },
];

export function Settings({ section }: { section?: SettingsSection }) {
  const { navigate } = useApp();
  const current = section ?? "sources";
  return (
    <div className="screen settings">
      <h1 className="sr-only">Settings</h1>
      <div className="set">
        <nav className="setnav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button type="button" key={s.id} className={current === s.id ? "on" : ""} aria-current={current === s.id ? "page" : undefined} onClick={() => navigate({ name: "settings", section: s.id }, { replace: true })}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="set-body">
          {current === "sources" ? <SourcesSection /> : null}
          {current === "channels" ? <ChannelsSection /> : null}
          {current === "playback" ? <PlaybackSection /> : null}
          {current === "reactors" ? <ReactorList /> : null}
          {current === "backup" ? <BackupSection /> : null}
          {current === "about" ? <AboutSection /> : null}
        </div>
      </div>
    </div>
  );
}

// ---------- Sources & guides ----------

function effectiveLimit(s: Source): number | null {
  if (s.maxConnections != null && s.userMaxConnections != null) return Math.min(s.maxConnections, s.userMaxConnections);
  return s.userMaxConnections ?? s.maxConnections;
}

function health(s: Source, now: number): { tone: "good" | "warn" | "bad" | "busy"; label: string } {
  if (s.status === "refreshing") return { tone: "busy", label: "Updating" };
  if (s.status === "error") return { tone: "bad", label: s.error ?? "Not working" };
  if (s.expiresAt && s.expiresAt < now) return { tone: "bad", label: "Expired" };
  if (s.expiresAt && s.expiresAt - now < 14 * DAY) return { tone: "warn", label: "Expires soon" };
  return { tone: "good", label: "Healthy" };
}

function SourcesSection() {
  const { sources, navigate, reloadSources, version, toast, usage } = useApp();
  const { data: groups } = useLoad(() => api.groupsList("live", true), [version, sources?.length]);
  const { data: unmatched, reload: reloadUnmatched } = useLoad(() => api.epgUnmatched(null), [version]);
  const [editing, setEditing] = useState<Source | null>(null);
  const [removing, setRemoving] = useState<Source | null>(null);
  const [fixList, setFixList] = useState(false);
  const [refreshingGuides, setRefreshingGuides] = useState(false);
  const now = Date.now();

  const shown = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups ?? []) if (!g.hidden) m.set(g.sourceId, (m.get(g.sourceId) ?? 0) + g.itemCount);
    return m;
  }, [groups]);

  const refresh = async (s: Source) => {
    try {
      await api.sourceRefresh(s.id);
      await reloadSources();
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <div className="srcs">
      {!sources ? (
        <>
          <Skeleton h="7rem" r={14} />
          <Skeleton h="7rem" r={14} />
        </>
      ) : sources.length === 0 ? (
        <Empty icon="live" title="No sources">
          <button type="button" className="btn pri" onClick={() => navigate({ name: "onboarding" })}>
            <Icon name="plus" /> Add source
          </button>
        </Empty>
      ) : (
        sources.map((s) => {
          const h = health(s, now);
          const lim = effectiveLimit(s);
          const inUse = usage.find((u) => u.sourceId === s.id)?.inUse ?? 0;
          return (
            <article className="srccard" key={s.id}>
              <div className="srccard-main">
                <h3>
                  {s.name} <span className="mute">· {s.kind === "xtream" ? "Xtream" : "M3U"}</span>
                </h3>
                <div className="k">
                  <span>
                    <b className="num">{(shown.get(s.id) ?? s.channelCount).toLocaleString()}</b> channels shown of {s.channelCount.toLocaleString()}
                  </span>
                  <span>
                    <b className="num">{Math.round(s.guideCoverage * 100)}%</b> guide matched
                  </span>
                  {s.movieCount || s.seriesCount ? (
                    <span>
                      <b className="num">{s.movieCount.toLocaleString()}</b> movies · <b className="num">{s.seriesCount.toLocaleString()}</b> series
                    </span>
                  ) : null}
                  {s.expiresAt ? (
                    <span>
                      Expires <b>{shortDate(s.expiresAt)}</b>
                    </span>
                  ) : null}
                  <span>
                    Updated <b>{s.lastRefreshed ? ago(s.lastRefreshed, now) : "never"}</b>
                  </span>
                  <span>
                    {lim != null ? (
                      <>
                        <b className="num">{inUse} of {lim}</b> streams in use{s.userMaxConnections != null ? " · your limit" : ""}
                      </>
                    ) : (
                      <>
                        <b className="num">{inUse}</b> streams in use · limit unknown
                      </>
                    )}
                  </span>
                </div>
              </div>
              <div className="srccard-side">
                <span className={`health ${h.tone}`}>
                  <i />
                  {h.label}
                </span>
                <div className="btns">
                  <button type="button" className="btn small" disabled={s.status === "refreshing"} onClick={() => void refresh(s)}>
                    <Icon name="refresh" /> Refresh
                  </button>
                  <button type="button" className="btn small" onClick={() => setEditing(s)}>
                    <Icon name="edit" /> Edit
                  </button>
                  <button type="button" className="btn small danger" aria-label={`Remove ${s.name}`} onClick={() => setRemoving(s)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            </article>
          );
        })
      )}
      <article className="srccard guides">
        <div className="srccard-main">
          <h3>Guides</h3>
          <div className="k">
            <span>
              {sources ? (
                <>
                  <b className="num">{sources.reduce((n, s) => n + s.epgUrls.length, 0)}</b> added guide links
                </>
              ) : null}
            </span>
            {unmatched ? (
              <span>
                <b className={unmatched.length ? "num warn" : "num"}>{unmatched.length}</b> {unmatched.length === 1 ? "channel" : "channels"} without guide
              </span>
            ) : null}
          </div>
        </div>
        <div className="srccard-side">
          <div className="btns">
            <button type="button" className="btn small" disabled={!unmatched?.length} onClick={() => setFixList(true)}>
              <Icon name="wrench" /> Fix unmatched channels
            </button>
            <button
              type="button"
              className="btn small"
              disabled={refreshingGuides}
              onClick={async () => {
                setRefreshingGuides(true);
                try {
                  await api.guidesRefresh();
                  toast("Guides updated", "good");
                  reloadUnmatched();
                } catch (e) {
                  toast(errorMessage(e), "bad");
                } finally {
                  setRefreshingGuides(false);
                }
              }}
            >
              <Icon name="refresh" /> Refresh guides
            </button>
            <button type="button" className="btn small pri" onClick={() => navigate({ name: "onboarding" })}>
              <Icon name="plus" /> Add source
            </button>
          </div>
        </div>
      </article>
      {editing ? <EditSource source={editing} onClose={() => setEditing(null)} /> : null}
      {removing ? <RemoveSource source={removing} onClose={() => setRemoving(null)} /> : null}
      {fixList && unmatched ? <UnmatchedList channels={unmatched} onClose={() => { setFixList(false); reloadUnmatched(); }} /> : null}
    </div>
  );
}

function EditSource({ source, onClose }: { source: Source; onClose: () => void }) {
  const { reloadSources, toast } = useApp();
  const [name, setName] = useState(source.name);
  const [epg, setEpg] = useState(source.epgUrls.join("\n"));
  const [limit, setLimit] = useState(source.userMaxConnections?.toString() ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const n = limit.trim() ? Number.parseInt(limit, 10) : null;
    if (n !== null && (!Number.isFinite(n) || n < 1 || n > 50)) {
      setError("Enter a number from 1 to 50, or leave it empty.");
      return;
    }
    setBusy(true);
    try {
      await api.sourceUpdate(source.id, {
        name: name.trim() || source.name,
        epgUrls: epg.split(/\s+/).map((x) => x.trim()).filter(Boolean),
        userMaxConnections: n,
        ...(password ? { password } : {}),
      });
      await reloadSources();
      toast("Saved", "good");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${source.name}`} onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Guide links (XMLTV), one per line</span>
        <textarea className="input area" value={epg} onChange={(e) => setEpg(e.target.value)} rows={3} spellCheck={false} placeholder="https://" />
      </label>
      <label className="field">
        <span>Streams at once{source.maxConnections != null ? ` (provider says ${source.maxConnections})` : ""}</span>
        <input className="input small" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ""))} placeholder={source.maxConnections?.toString() ?? "—"} aria-label="Connection limit override" />
      </label>
      {source.kind === "xtream" ? (
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      ) : null}
      {error ? <p className="error-line">{error}</p> : null}
      <div className="btns">
        <button type="button" className="btn pri" disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function RemoveSource({ source, onClose }: { source: Source; onClose: () => void }) {
  const { reloadSources, toast, bump, navigate } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Remove ${source.name}?`} onClose={onClose}>
      <p className="mute">Its channels, favorites and guide matches are removed from Radiate.</p>
      <div className="btns">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.sourceRemove(source.id);
              const left = await api.sourcesList();
              await reloadSources();
              bump();
              toast(`${source.name} removed`);
              onClose();
              if (!left.length) navigate({ name: "onboarding" });
            } catch (e) {
              toast(errorMessage(e), "bad");
              setBusy(false);
            }
          }}
        >
          <Icon name="trash" /> Remove
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function UnmatchedList({ channels, onClose }: { channels: Channel[]; onClose: () => void }) {
  const [fixing, setFixing] = useState<Channel | null>(null);
  const { sourceName } = useApp();
  if (fixing) return <EpgMatchPicker channel={fixing} onClose={() => setFixing(null)} />;
  return (
    <Modal title="Channels without guide" onClose={onClose}>
      <div className="cand-list">
        {channels.map((c) => (
          <button type="button" key={c.id} className="cand" onClick={() => setFixing(c)}>
            <Logo name={c.name} src={c.logo} />
            <span className="cand-main">
              <b className="ellipsis">{c.name}</b>
              <span className="ellipsis mute">{sourceName(c.sourceId)} · {c.groupName}</span>
            </span>
            <Icon name="right" />
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------- Channels & groups ----------

function ChannelsSection() {
  const { version, bump, toast, sourceName, setPrefs } = useApp();
  const overrides = useSportsOverrides();
  const { data: groups, reload } = useLoad(() => api.groupsList("live", true), [version]);
  const [numbersFor, setNumbersFor] = useState<string | null>(null);
  const { data: hidden, reload: reloadHidden } = useLoad(
    () => api.channelsList({ includeHidden: true, favoritesOnly: false, offset: 0, limit: 5000 }).then((p) => p.items.filter((c) => c.hidden)),
    [version],
  );
  const [order, setOrder] = useState<Group[] | null>(null);
  useEffect(() => setOrder(groups), [groups]);

  const setHidden = async (g: Group, h: boolean) => {
    setOrder((o) => o?.map((x) => (x.id === g.id ? { ...x, hidden: h } : x)) ?? o);
    try {
      await api.groupSetHidden(g.id, h);
      bump();
    } catch (e) {
      toast(errorMessage(e), "bad");
      reload();
    }
  };
  const move = async (i: number, d: number) => {
    if (!order) return;
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const n = [...order];
    [n[i], n[j]] = [n[j]!, n[i]!];
    setOrder(n);
    try {
      await api.groupsReorder(n.map((g) => g.id));
      bump();
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <div className="set-stack">
      <section className="set-card">
        <h3>Groups</h3>
        {!order ? (
          <Skeleton h="12rem" r={12} />
        ) : (
          <div className="group-rows">
            {order.map((g, i) => (
              <div className={g.hidden ? "grow-set off" : "grow-set"} key={g.id}>
                <input type="checkbox" className="toggle" checked={!g.hidden} onChange={(e) => void setHidden(g, !e.target.checked)} aria-label={`Show ${g.name}`} />
                <span className="ellipsis grow-name">{g.name}</span>
                <SportsTag on={isSportsGroup(g, overrides)} name={g.name} onToggle={() => void setPrefs({ sportsGroups: toggleSportsGroup(overrides, g) })} />
                <span className="mute ellipsis">{sourceName(g.sourceId)}</span>
                <span className="mute num">{g.itemCount}</span>
                <button type="button" className="icon-btn" aria-label={`Channel numbers in ${g.name}`} onClick={() => setNumbersFor(g.id)}>
                  <Icon name="list" />
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${g.name} up`} disabled={i === 0} onClick={() => void move(i, -1)}>
                  <Icon name="up" />
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${g.name} down`} disabled={i === order.length - 1} onClick={() => void move(i, 1)}>
                  <Icon name="down" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="set-card">
        <h3>Hidden channels</h3>
        {!hidden ? (
          <Skeleton h="3rem" r={12} />
        ) : hidden.length === 0 ? (
          <p className="mute">None</p>
        ) : (
          <div className="group-rows">
            {hidden.map((c) => (
              <div className="grow-set" key={c.id}>
                <Logo name={c.name} src={c.logo} />
                <span className="ellipsis grow-name">{c.name}</span>
                <span className="mute">{c.groupName}</span>
                <button
                  type="button"
                  className="btn small"
                  onClick={async () => {
                    await api.channelSetHidden(c.id, false).catch((e: unknown) => toast(errorMessage(e), "bad"));
                    reloadHidden();
                    bump();
                  }}
                >
                  <Icon name="eye" /> Show
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {numbersFor ? <NumbersModal groupId={numbersFor} name={order?.find((g) => g.id === numbersFor)?.name ?? ""} onClose={() => setNumbersFor(null)} /> : null}
    </div>
  );
}

function SportsTag({ on, name, onToggle }: { on: boolean; name: string; onToggle: () => void }) {
  return (
    <button type="button" className={on ? "sport-tag on" : "sport-tag"} aria-pressed={on} aria-label={`${name} is sports`} onClick={onToggle}>
      <Icon name="ball" /> Sports
    </button>
  );
}

function NumbersModal({ groupId, name, onClose }: { groupId: string; name: string; onClose: () => void }) {
  const { toast, bump } = useApp();
  const { data } = useLoad(() => api.channelsList({ groupId, includeHidden: true, favoritesOnly: false, offset: 0, limit: 2000 }), [groupId]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = async (c: Channel) => {
    const v = edits[c.id];
    if (v === undefined) return;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n === c.number) return;
    try {
      await api.channelSetNumber(c.id, n);
      toast(`${c.name} is now ${n}`, "good");
      bump();
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };
  return (
    <Modal title={`Channel numbers · ${name}`} onClose={onClose}>
      {!data ? (
        <Skeleton h="10rem" r={12} />
      ) : (
        <div className="group-rows">
          {data.items.map((c) => (
            <div className="grow-set" key={c.id}>
              <input
                className="input small num"
                inputMode="numeric"
                aria-label={`Number for ${c.name}`}
                value={edits[c.id] ?? String(c.number)}
                onChange={(e) => setEdits((x) => ({ ...x, [c.id]: e.target.value.replace(/[^0-9]/g, "") }))}
                onBlur={() => void save(c)}
                onKeyDown={(e) => e.key === "Enter" && void save(c)}
              />
              <Logo name={c.name} src={c.logo} />
              <span className="ellipsis grow-name">{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------- Playback ----------

function PlaybackSection() {
  const { prefs, setPrefs } = useApp();
  if (!prefs) return <Skeleton h="10rem" r={14} />;
  return (
    <div className="set-stack">
      <section className="set-card">
        <div className="set-row">
          <span>Stream stats</span>
          <input type="checkbox" className="toggle" checked={prefs.showStats} onChange={(e) => void setPrefs({ showStats: e.target.checked })} aria-label="Show stream stats" />
        </div>
        <div className="set-row">
          <span>Volume</span>
          <input type="range" className="range" style={{ "--fill": `${prefs.volume * 100}%` } as React.CSSProperties} min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => void setPrefs({ volume: Number(e.target.value) })} aria-label="Volume" />
          <span className="mute num set-val">{Math.round(prefs.volume * 100)}%</span>
        </div>
        <div className="set-row">
          <span>Start muted</span>
          <input type="checkbox" className="toggle" checked={prefs.muted} onChange={(e) => void setPrefs({ muted: e.target.checked })} aria-label="Muted" />
        </div>
        <div className="set-row">
          <span>Live buffer</span>
          <Segmented
            label="Live buffer"
            value={prefs.latency ?? "normal"}
            options={[
              { id: "low", label: "Minimal" },
              { id: "normal", label: "10 s" },
              { id: "stable", label: "20 s" },
            ]}
            onChange={(v) => void setPrefs({ latency: v })}
          />
        </div>
        <div className="set-row">
          <span>Live format</span>
          <Segmented
            label="Live format"
            value={prefs.liveFormat ?? "auto"}
            options={[
              { id: "auto", label: "Auto" },
              { id: "ts", label: "MPEG-TS" },
              { id: "hls", label: "HLS" },
            ]}
            onChange={(v) => void setPrefs({ liveFormat: v })}
          />
        </div>
        <div className="set-row">
          <span>Guide refresh</span>
          <select className="input select" value={prefs.epgRefreshHours} onChange={(e) => void setPrefs({ epgRefreshHours: Number(e.target.value) })} aria-label="Guide refresh interval">
            {[6, 12, 24, 48].map((h) => (
              <option key={h} value={h}>
                Every {h} hours
              </option>
            ))}
          </select>
        </div>
      </section>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.id} role="radio" aria-checked={o.id === value} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Backup ----------

function BackupSection() {
  const { toast, reloadSources, bump, setPrefs } = useApp();
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const doExport = async () => {
    const path = await pickSaveFile("radiate-settings.json", [{ name: "Radiate settings", extensions: ["json"] }]);
    if (!path) return;
    setBusy(true);
    try {
      await api.settingsExport(path, secrets);
      toast("Settings exported", "good");
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    const path = await pickOpenFile([{ name: "Radiate settings", extensions: ["json"] }]);
    if (!path) return;
    setBusy(true);
    try {
      await api.settingsImport(path);
      await reloadSources();
      const p = await api.prefsGet();
      await setPrefs(p);
      bump();
      toast("Settings imported", "good");
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-stack">
      <section className="set-card">
        <h3>Export</h3>
        <label className="check">
          <input type="checkbox" checked={secrets} onChange={(e) => setSecrets(e.target.checked)} />
          Include passwords
        </label>
        <div className="btns">
          <button type="button" className="btn" disabled={busy} onClick={() => void doExport()}>
            <Icon name="download" /> Export…
          </button>
        </div>
      </section>
      <section className="set-card">
        <h3>Import</h3>
        <div className="btns">
          <button type="button" className="btn" disabled={busy} onClick={() => void doImport()}>
            <Icon name="upload" /> Import…
          </button>
        </div>
      </section>
    </div>
  );
}

// ---------- About ----------

function AboutSection() {
  const { data } = useLoad<AppInfo>(() => api.appInfo(), []);
  return (
    <div className="set-stack">
      <section className="set-card about">
        <div className="about-head">
          <div className="brand-mark lg">R</div>
          <div>
            <h3>Radiate</h3>
            <span className="mute num">{data ? `Version ${data.version}` : " "}</span>
          </div>
        </div>
        <dl className="facts-list">
          <dt>Licence</dt>
          <dd>MIT</dd>
          <dt>Telemetry</dt>
          <dd>None</dd>
          <dt>Data folder</dt>
          <dd className="mono">{data?.dataDir ?? "…"}</dd>
        </dl>
      </section>
      <UpdateSection />
    </div>
  );
}
