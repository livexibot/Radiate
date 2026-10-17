import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Group, type NewSource, type Progress as ProgressEvt, type Source } from "../api";
import { pickOpenFile } from "../api/dialogs";
import { Icon } from "../components/Icon";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { COUNTRIES, publicCatalogUrl } from "../lib/countries";
import { useApp } from "../state/app";

type Kind = "m3u" | "xtream" | "free";
type Step = "choose" | "form" | "progress" | "groups";

const PHASES: { id: string; label: string }[] = [
  { id: "playlist", label: "Channels" },
  { id: "vod", label: "Movies and series" },
  { id: "guide", label: "Guide" },
  { id: "matching", label: "Matching guide to channels" },
];

const OPTIONS: { kind: Kind; ico: string; title: string }[] = [
  { kind: "m3u", ico: "M3U", title: "Playlist link" },
  { kind: "xtream", ico: "XC", title: "Xtream Codes login" },
  { kind: "free", ico: "FREE", title: "Free public channels" },
];

export function Onboarding({ firstRun }: { firstRun: boolean }) {
  const { navigate, back, reloadSources, setPrefs, bump, prefs } = useApp();
  const [step, setStep] = useState<Step>("choose");
  const [kind, setKind] = useState<Kind>("m3u");
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [phase, setPhase] = useState<ProgressEvt | null>(null);
  const [donePhases, setDonePhases] = useState<Set<string>>(new Set());

  const finish = async () => {
    if (!prefs?.onboarded) await setPrefs({ onboarded: true });
    await reloadSources();
    bump();
    navigate({ name: "home" });
  };

  const add = async (input: NewSource) => {
    setError(null);
    setStep("progress");
    setPhase(null);
    setDonePhases(new Set());
    let watched: string | null = null;
    const off = api.on("source-progress", (p) => {
      watched ??= p.sourceId;
      if (p.sourceId !== watched) return;
      setPhase(p);
      setDonePhases((d) => {
        const n = new Set(d);
        const idx = PHASES.findIndex((x) => x.id === p.phase);
        PHASES.slice(0, idx < 0 ? PHASES.length : idx).forEach((x) => n.add(x.id));
        if (p.phase === "done") PHASES.forEach((x) => n.add(x.id));
        return n;
      });
    });
    try {
      const s = await api.sourceAdd(input);
      setSource(s);
      setStep("groups");
    } catch (e) {
      setError(errorMessage(e));
      setStep("form");
    } finally {
      off();
    }
  };

  return (
    <div className="ob">
      <div className="ob-l">
        <div className="brand-mark lg">R</div>
        <h1>{step === "groups" ? "Pick your groups" : step === "progress" ? "Loading your source" : "Add a source"}</h1>
        <ol className="ob-steps">
          {["Source", "Loading", "Groups"].map((label, i) => {
            const at = step === "choose" || step === "form" ? 0 : step === "progress" ? 1 : 2;
            return (
              <li key={label} className={i < at ? "done" : i === at ? "on" : ""}>
                <span className="ob-step-dot">{i < at ? <Icon name="check" /> : i + 1}</span>
                {label}
              </li>
            );
          })}
        </ol>
        {!firstRun ? (
          <button type="button" className="btn ghost ob-close" onClick={back}>
            <Icon name="back" /> Cancel
          </button>
        ) : null}
      </div>
      <div className="ob-r">
        {step === "choose" ? (
          <div className="ob-options">
            {OPTIONS.map((o) => (
              <button
                type="button"
                key={o.kind}
                className={kind === o.kind ? "src-opt sel" : "src-opt"}
                onClick={() => {
                  setKind(o.kind);
                  setStep("form");
                }}
                onFocus={() => setKind(o.kind)}
              >
                <span className="src-ico">{o.ico}</span>
                <b className="src-name">{o.title}</b>
                <Icon name="right" />
              </button>
            ))}
          </div>
        ) : null}
        {step === "form" || step === "progress" ? (
          // stays mounted while loading so a failed attempt comes back with the fields still filled in
          <div hidden={step === "progress"}>
            <SourceForm kind={kind} error={error} onBack={() => setStep("choose")} onSubmit={(i) => void add(i)} />
          </div>
        ) : null}
        {step === "progress" ? (
          <div className="ob-progress">
            {PHASES.map((p) => {
              const active = phase?.phase === p.id;
              const done = donePhases.has(p.id);
              const share = active && phase?.total ? phase.done / phase.total : done ? 1 : 0;
              return (
                <div key={p.id} className={done ? "phase done" : active ? "phase on" : "phase"}>
                  <span className="phase-dot">{done ? <Icon name="check" /> : null}</span>
                  <span className="phase-main">
                    <b>{p.label}</b>
                    {active && phase?.total && p.id === "playlist" ? <span className="mute num">{phase.done.toLocaleString()} of {phase.total.toLocaleString()}</span> : null}
                    <Progress value={share} />
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {step === "groups" && source ? <GroupPicker source={source} onDone={() => void finish()} /> : null}
      </div>
    </div>
  );
}

function SourceForm({ kind, error, onBack, onSubmit }: { kind: Kind; error: string | null; onBack: () => void; onSubmit: (i: NewSource) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [server, setServer] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [epg, setEpg] = useState("");
  const [country, setCountry] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), [kind]);
  const countries = useMemo(() => COUNTRIES.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase())), [filter]);
  const epgUrls = epg.trim() ? [epg.trim()] : [];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === "m3u") onSubmit({ kind: "m3u", name: name.trim() || "My playlist", url: url.trim(), epgUrls });
    else if (kind === "xtream") onSubmit({ kind: "xtream", name: name.trim() || "My provider", server: server.trim(), username: user.trim(), password: pass, epgUrls });
    else if (country) {
      const c = COUNTRIES.find((x) => x.code === country);
      onSubmit({ kind: "m3u", name: `Free channels · ${c?.name ?? country.toUpperCase()}`, url: publicCatalogUrl(country), epgUrls: [] });
    }
  };

  const canSubmit = kind === "m3u" ? !!url.trim() : kind === "xtream" ? !!server.trim() && !!user.trim() && !!pass : !!country;

  return (
    <form className="ob-form" onSubmit={submit}>
      <h2>{OPTIONS.find((o) => o.kind === kind)?.title}</h2>
      {kind === "m3u" ? (
        <>
          <label className="field">
            <span>Playlist link</span>
            <div className="field-row">
              <input ref={firstRef} className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" spellCheck={false} />
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const p = await pickOpenFile([{ name: "Playlist", extensions: ["m3u", "m3u8"] }]);
                  if (p) setUrl(p);
                }}
              >
                <Icon name="file" /> Choose file
              </button>
            </div>
          </label>
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My playlist" />
          </label>
          <label className="field">
            <span>Guide link (XMLTV, optional)</span>
            <input className="input" value={epg} onChange={(e) => setEpg(e.target.value)} placeholder="https://" spellCheck={false} />
          </label>
        </>
      ) : null}
      {kind === "xtream" ? (
        <>
          <label className="field">
            <span>Server</span>
            <input ref={firstRef} className="input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://line.example.com:8080" spellCheck={false} />
          </label>
          <div className="field-2">
            <label className="field">
              <span>Username</span>
              <input className="input" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
            </label>
          </div>
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My provider" />
          </label>
        </>
      ) : null}
      {kind === "free" ? (
        <>
          <label className="field">
            <span>Country</span>
            <input ref={firstRef} className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search countries" />
          </label>
          <div className="country-list" role="listbox" aria-label="Countries">
            {countries.map((c) => (
              <button type="button" key={c.code} role="option" aria-selected={country === c.code} className={country === c.code ? "country on" : "country"} onClick={() => setCountry(c.code)}>
                <span className="country-code">{c.code.toUpperCase()}</span>
                {c.name}
                {country === c.code ? <Icon name="check" /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {error ? <p className="error-line" role="alert">{error}</p> : null}
      <div className="btns">
        <button type="button" className="btn ghost" onClick={onBack}>
          <Icon name="back" /> Back
        </button>
        <button type="submit" className="btn pri" disabled={!canSubmit}>
          Add source
        </button>
      </div>
    </form>
  );
}

function GroupPicker({ source, onDone }: { source: Source; onDone: () => void }) {
  const { toast } = useApp();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.groupsList("live", true, source.id).then(
      (g) => {
        setGroups(g);
        setOn(new Set(g.filter((x) => !x.hidden).map((x) => x.id)));
      },
      () => setGroups([]),
    );
  }, [source.id]);
  const toggle = (id: string) =>
    setOn((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const save = async () => {
    if (!groups) return;
    setBusy(true);
    try {
      await Promise.all(groups.map((g) => (g.hidden === !on.has(g.id) ? null : api.groupSetHidden(g.id, !on.has(g.id)))));
      onDone();
    } catch (e) {
      toast(errorMessage(e), "bad");
      setBusy(false);
    }
  };
  const total = groups?.reduce((n, g) => n + (on.has(g.id) ? g.itemCount : 0), 0) ?? 0;
  return (
    <div className="ob-groups">
      <div className="ob-groups-head">
        <b>{source.name}</b>
        <span className="mute num">{total.toLocaleString()} channels</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={() => setOn(new Set(groups?.map((g) => g.id)))}>
          All
        </button>
        <button type="button" className="btn small ghost" onClick={() => setOn(new Set())}>
          None
        </button>
      </div>
      <div className="group-checks">
        {!groups
          ? Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h="2.8rem" r={12} />)
          : groups.map((g) => (
              <label key={g.id} className={on.has(g.id) ? "gcheck on" : "gcheck"}>
                <input type="checkbox" checked={on.has(g.id)} onChange={() => toggle(g.id)} />
                <span className="ellipsis">{g.name}</span>
                <span className="mute num">{g.itemCount}</span>
              </label>
            ))}
      </div>
      <div className="btns">
        <button type="button" className="btn pri" disabled={busy || !groups} onClick={() => void save()}>
          Continue
        </button>
      </div>
    </div>
  );
}
