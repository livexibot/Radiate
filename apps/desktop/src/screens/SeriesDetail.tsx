import { useEffect, useMemo, useState } from "react";
import { api, type Episode, type SeriesInfo } from "../api";
import { Icon } from "../components/Icon";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { tone } from "../lib/monogram";
import { minutesLeft } from "../lib/time";
import { useApp } from "../state/app";
import { useLoad } from "../state/hooks";
import { episodeTitle, resumeFraction } from "../player/vodLogic";

/** The episode to resume: the first one started but not finished, else the one after the last finished. */
export function resumeEpisode(info: SeriesInfo): Episode | null {
  const all = info.seasons.flatMap((s) => s.episodes);
  const started = all.filter((e) => (e.progress ?? 0) > 0.01);
  const partial = started.filter((e) => (e.progress ?? 0) < 0.95);
  if (partial.length) return partial[partial.length - 1]!;
  if (!started.length) return null;
  const lastDone = started[started.length - 1]!;
  return all[all.indexOf(lastDone) + 1] ?? null;
}

export function SeriesDetail({ id }: { id: string }) {
  const { navigate, back, version } = useApp();
  const { data: info, error } = useLoad(() => api.seriesInfo(id), [id, version]);
  const resume = useMemo(() => (info ? resumeEpisode(info) : null), [info]);
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => {
    if (info && season === null) setSeason(resume?.season ?? info.seasons[0]?.number ?? 1);
  }, [info, resume, season]);
  const eps = info?.seasons.find((s) => s.number === season)?.episodes ?? [];
  const play = (e: Episode) => navigate({ name: "player", target: { type: "episode", id: e.id }, resume: resumeFraction(e.progress), title: episodeTitle(info?.name ?? "", e) });
  const years = info?.year ? String(info.year) : null;

  return (
    <div className="screen detail series">
      <div className={`detail-bg ${info ? tone(info.name) : ""}`} aria-hidden="true">
        {info?.poster ? <img src={info.poster} alt="" /> : null}
      </div>
      <button type="button" className="icon-btn detail-back" aria-label="Back" onClick={back}>
        <Icon name="back" />
      </button>
      <div className="detail-body">
        {error ? (
          <p className="error-line">{error}</p>
        ) : !info ? (
          <div className="detail-info">
            <Skeleton w="10rem" h="1.4rem" />
            <Skeleton w="26rem" h="3rem" />
            <Skeleton w="30rem" h="1rem" />
          </div>
        ) : (
          <div className="detail-info">
            <span className="pill ghost">Series</span>
            <h1>{info.name}</h1>
            <div className="facts">
              {info.rating ? <span className="rt">★ {info.rating.toFixed(1)}</span> : null}
              {years ? <span>{years}</span> : null}
              <span>
                {info.seasons.length} {info.seasons.length === 1 ? "season" : "seasons"}
              </span>
            </div>
            {info.plot ? <p>{info.plot}</p> : null}
            <div className="btns">
              {resume ? (
                <button type="button" className="btn pri" onClick={() => play(resume)}>
                  <Icon name="play" /> {(resume.progress ?? 0) > 0.01 ? "Resume" : "Play"} S{resume.season} · E{resume.episode}
                </button>
              ) : info.seasons[0]?.episodes[0] ? (
                <button type="button" className="btn pri" onClick={() => play(info.seasons[0]!.episodes[0]!)}>
                  <Icon name="play" /> Play S1 · E1
                </button>
              ) : null}
            </div>
          </div>
        )}
        {info ? (
          <div className="episodes-wrap">
            <div className="chips" role="tablist" aria-label="Seasons">
              {info.seasons.map((s) => (
                <button type="button" role="tab" key={s.number} aria-selected={s.number === season} className={s.number === season ? "chip on" : "chip"} onClick={() => setSeason(s.number)}>
                  Season {s.number}
                </button>
              ))}
            </div>
            <div className="eps">
              {eps.map((e) => {
                const p = e.progress ?? 0;
                const label = p >= 0.95 ? "Watched" : p > 0.01 && e.durationSecs ? minutesLeft(e.durationSecs * (1 - p)) : e.durationSecs ? `${Math.round(e.durationSecs / 60)} min` : "";
                return (
                  <button type="button" key={e.id} className="ep" onClick={() => play(e)} aria-label={`Episode ${e.episode}, ${e.title}`}>
                    <span className={`ep-th ${tone(`${info.name}${e.id}`)}`}>
                      {e.still ? <img src={e.still} alt="" loading="lazy" /> : null}
                      {label ? <span className="wt">{label}</span> : null}
                      {p > 0.01 ? <Progress value={p} className="ep-bar" /> : null}
                    </span>
                    <b className="ellipsis">
                      E{e.episode} · {e.title}
                    </b>
                    <span className="mute">Season {e.season}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
