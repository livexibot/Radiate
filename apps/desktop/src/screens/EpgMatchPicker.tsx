import { useEffect, useState } from "react";
import { api, errorMessage, type Channel, type EpgCandidate } from "../api";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Modal } from "../components/Modal";
import { Skeleton } from "../components/Skeleton";
import { useApp } from "../state/app";
import { useDebounced } from "../state/hooks";

/** Pick the XMLTV channel that carries the guide for `channel`. */
export function EpgMatchPicker({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const { toast, bump } = useApp();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 200);
  const [list, setList] = useState<EpgCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setList(null);
    api.epgCandidates(channel.id, query || null).then(
      (c) => alive && setList(c),
      (e: unknown) => {
        if (!alive) return;
        setList([]);
        toast(errorMessage(e), "bad");
      },
    );
    return () => {
      alive = false;
    };
  }, [channel.id, query, toast]);

  const choose = async (epgChannelId: string | null, label: string) => {
    setBusy(true);
    try {
      await api.epgSetMatch(channel.id, epgChannelId);
      toast(epgChannelId ? `${channel.name} now uses the guide for ${label}` : `Guide removed from ${channel.name}`, "good");
      bump();
      onClose();
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Fix guide · ${channel.name}`} onClose={onClose}>
      <label className="search-field">
        <Icon name="search" />
        <input className="input" placeholder={channel.name} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search guide channels" />
      </label>
      <div className="cand-list" role="listbox" aria-label="Guide channels">
        {list === null
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h="3.2rem" r={12} />)
          : list.length === 0
            ? <p className="mute">No guide channels match.</p>
            : list.map((c) => (
                <button type="button" key={c.epgChannelId} className={channel.epgChannelId === c.epgChannelId ? "cand on" : "cand"} disabled={busy} onClick={() => void choose(c.epgChannelId, c.displayName)}>
                  <Logo name={c.displayName} src={c.icon} />
                  <span className="cand-main">
                    <b className="ellipsis">{c.displayName}</b>
                    <span className="ellipsis mute">{c.epgChannelId}</span>
                  </span>
                  <span className="cand-score num">{Math.round(c.score * 100)}%</span>
                </button>
              ))}
      </div>
      {channel.epgChannelId ? (
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void choose(null, "")}>
          No guide for this channel
        </button>
      ) : null}
    </Modal>
  );
}
