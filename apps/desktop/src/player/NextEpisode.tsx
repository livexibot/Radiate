import { useEffect, useState } from "react";
import { api, type Episode, type PlayTarget } from "../api";
import { Icon } from "../components/Icon";
import { NEXT_COUNTDOWN_SECS, nextEpisode, type NextPhase } from "./vodLogic";
import "./vod.css";

export interface NextUp {
  episode: Episode;
  seriesName: string;
}

/** For an episode: the one after it in the series (loaded once per episode), else null. */
export function useNextEpisode(target: PlayTarget): NextUp | null {
  const [next, setNext] = useState<NextUp | null>(null);
  const id = target.type === "episode" ? target.id : null;
  useEffect(() => {
    setNext(null);
    if (!id) return;
    let alive = true;
    void (async () => {
      try {
        const item = await api.vodGet(id);
        if (!item.seriesId) return;
        const info = await api.seriesInfo(item.seriesId);
        const e = nextEpisode(info, id);
        if (alive && e) setNext({ episode: e, seriesName: info.name });
      } catch {
        /* no next episode offered */
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);
  return next;
}

/** "Next episode" near the end of an episode; after it ends, a countdown that can be cancelled. */
export function NextEpisodeCard({ next, phase, onPlay, onCancel }: { next: NextUp; phase: Exclude<NextPhase, "hidden">; onPlay: () => void; onCancel: () => void }) {
  const [left, setLeft] = useState(NEXT_COUNTDOWN_SECS);
  useEffect(() => {
    if (phase !== "countdown") {
      setLeft(NEXT_COUNTDOWN_SECS);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => {
      const remain = Math.max(0, NEXT_COUNTDOWN_SECS - Math.floor((Date.now() - started) / 1000));
      setLeft(remain);
      if (remain === 0) {
        window.clearInterval(t);
        onPlay();
      }
    }, 250);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, next.episode.id]);

  const e = next.episode;
  return (
    <div className="next-ep" role="dialog" aria-label="Next episode">
      <span className="next-ep-kicker">{phase === "countdown" ? `Next episode in ${left}` : "Next episode"}</span>
      <b>
        S{e.season} · E{e.episode} · {e.title}
      </b>
      {phase === "countdown" ? (
        <span className="next-ep-count" aria-hidden="true">
          <i style={{ width: `${(left / NEXT_COUNTDOWN_SECS) * 100}%` }} />
        </span>
      ) : null}
      <div className="next-ep-btns">
        <button type="button" className="btn pri" onClick={onPlay}>
          <Icon name="play" /> Next episode
        </button>
        {phase === "countdown" ? (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
