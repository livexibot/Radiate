import { useState } from "react";
import { api, errorMessage, type CustomChannel } from "../api";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Modal } from "../components/Modal";
import { Skeleton } from "../components/Skeleton";
import { USER_AGENTS } from "../lib/userAgents";
import { useApp } from "../state/app";
import { useLoad } from "../state/hooks";

/** Streams added by their address. They show up as the "My channels" source. */
export function MyChannels() {
  const { toast, reloadSources, bump } = useApp();
  const { data, reload } = useLoad(() => api.customChannelsGet(), []);
  const [editing, setEditing] = useState<{ index: number; channel: CustomChannel } | null>(null);

  const save = async (list: CustomChannel[]) => {
    try {
      await api.customChannelsSet(list);
      reload();
      await reloadSources();
      bump();
      return true;
    } catch (e) {
      toast(errorMessage(e), "bad");
      return false;
    }
  };

  return (
    <section className="set-card" data-ui="settings-card">
      <div className="set-card-head">
        <h3>My channels</h3>
        <button type="button" className="btn small" onClick={() => setEditing({ index: -1, channel: { name: "", url: "" } })}>
          <Icon name="plus" /> Add
        </button>
      </div>
      {!data ? (
        <Skeleton h="3rem" r={12} />
      ) : data.length === 0 ? (
        <p className="mute">None</p>
      ) : (
        <div className="group-rows">
          {data.map((c, i) => (
            <div className="grow-set" key={`${c.name}-${i}`}>
              <Logo name={c.name} src={c.logo ?? null} />
              <span className="ellipsis grow-name">{c.name}</span>
              <span className="mute ellipsis">{c.group || "My channels"}</span>
              <button type="button" className="icon-btn" aria-label={`Edit ${c.name}`} onClick={() => setEditing({ index: i, channel: c })}>
                <Icon name="edit" />
              </button>
              <button type="button" className="icon-btn" aria-label={`Remove ${c.name}`} onClick={() => void save(data.filter((_, j) => j !== i))}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
      {editing && data ? (
        <ChannelEditor
          channel={editing.channel}
          isNew={editing.index < 0}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const list = editing.index < 0 ? [...data, c] : data.map((x, j) => (j === editing.index ? c : x));
            if (await save(list)) setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ChannelEditor({ channel, isNew, onClose, onSave }: { channel: CustomChannel; isNew: boolean; onClose: () => void; onSave: (c: CustomChannel) => Promise<void> }) {
  const [c, setC] = useState<CustomChannel>(channel);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(!!(channel.userAgent || channel.referrer || channel.origin));
  const set = (k: keyof CustomChannel) => (e: React.ChangeEvent<HTMLInputElement>) => setC((x) => ({ ...x, [k]: e.target.value }));
  const clean = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
  const ok = !!c.name.trim() && /^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(c.url.trim());
  return (
    <Modal title={isNew ? "Add a channel" : `Edit ${channel.name}`} onClose={onClose}>
      <form
        className="set-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok) return;
          setBusy(true);
          await onSave({
            name: c.name.trim(),
            url: c.url.trim(),
            group: clean(c.group),
            logo: clean(c.logo),
            userAgent: clean(c.userAgent),
            referrer: clean(c.referrer),
            origin: clean(c.origin),
          });
          setBusy(false);
        }}
      >
        <label className="field">
          <span>Name</span>
          <input className="input" value={c.name} onChange={set("name")} />
        </label>
        <label className="field">
          <span>Stream link</span>
          <input className="input" value={c.url} onChange={set("url")} placeholder="https://" spellCheck={false} inputMode="url" />
        </label>
        <div className="field-2">
          <label className="field">
            <span>Group</span>
            <input className="input" value={c.group ?? ""} onChange={set("group")} placeholder="My channels" />
          </label>
          <label className="field">
            <span>Logo link</span>
            <input className="input" value={c.logo ?? ""} onChange={set("logo")} placeholder="https://" spellCheck={false} />
          </label>
        </div>
        {more ? (
          <>
            <label className="field">
              <span>User agent</span>
              <input className="input" list="ua-presets-custom" value={c.userAgent ?? ""} onChange={set("userAgent")} spellCheck={false} />
              <datalist id="ua-presets-custom">
                {USER_AGENTS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </datalist>
            </label>
            <div className="field-2">
              <label className="field">
                <span>Referrer</span>
                <input className="input" value={c.referrer ?? ""} onChange={set("referrer")} spellCheck={false} />
              </label>
              <label className="field">
                <span>Origin</span>
                <input className="input" value={c.origin ?? ""} onChange={set("origin")} spellCheck={false} />
              </label>
            </div>
          </>
        ) : (
          <button type="button" className="btn ghost small more-btn" onClick={() => setMore(true)}>
            <Icon name="down" /> Headers
          </button>
        )}
        <div className="btns">
          <button type="submit" className="btn pri" disabled={!ok || busy}>
            Save
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
