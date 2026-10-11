import { api, type VodItem } from "../api";
import { Icon } from "../components/Icon";
import { Progress } from "../components/Progress";
import { Skeleton } from "../components/Skeleton";
import { tone } from "../lib/monogram";
import { useApp } from "../state/app";
import { useLoad } from "../state/hooks";

/** Movie detail. The contract has no single-item VOD call, so the item is found through vod_list. */
async function findMovie(id: string): Promise<VodItem> {
  const page = 500;
  for (let offset = 0; offset < 20_000; offset += page) {
    const p = await api.vodList({ kind: "movie", offset, limit: page });
    const hit = p.items.find((x) => x.id === id);
    if (hit) return hit;
    if (offset + page >= p.total) break;
  }
  throw new Error("This movie is no longer in your sources.");
}

export function MovieDetail({ id }: { id: string }) {
  const { navigate, back, version, sourceName } = useApp();
  const { data: m, error } = useLoad(() => findMovie(id), [id, version]);
  const play = (resume?: number) => navigate({ name: "player", target: { type: "movie", id }, resume, title: m?.name });
  const inProgress = !!m?.progress && m.progress > 0.01 && m.progress < 0.95;

  return (
    <div className="screen detail">
      <div className={`detail-bg ${m ? tone(m.name) : ""}`} aria-hidden="true">
        {m?.poster ? <img src={m.poster} alt="" /> : null}
      </div>
      <button type="button" className="icon-btn detail-back" aria-label="Back" onClick={back}>
        <Icon name="back" />
      </button>
      <div className="detail-body">
        {error ? (
          <p className="error-line">{error}</p>
        ) : !m ? (
          <div className="detail-info">
            <Skeleton w="12rem" h="1.6rem" />
            <Skeleton w="28rem" h="3rem" />
            <Skeleton w="22rem" h="1rem" />
          </div>
        ) : (
          <div className="detail-info">
            <span className="pill ghost">Movie · {sourceName(m.sourceId)}</span>
            <h1>{m.name}</h1>
            <div className="facts">
              {m.rating ? <span className="rt">★ {m.rating.toFixed(1)}</span> : null}
              {m.year ? <span>{m.year}</span> : null}
              <span>{m.groupName}</span>
            </div>
            {m.plot ? <p>{m.plot}</p> : null}
            {inProgress ? (
              <div className="detail-progress">
                <Progress value={m.progress} />
                <span className="mute num">{Math.round((m.progress ?? 0) * 100)}%</span>
              </div>
            ) : null}
            <div className="btns">
              {inProgress ? (
                <>
                  <button type="button" className="btn pri" onClick={() => play(m.progress ?? undefined)}>
                    <Icon name="play" /> Resume
                  </button>
                  <button type="button" className="btn" onClick={() => play(0)}>
                    From the start
                  </button>
                </>
              ) : (
                <button type="button" className="btn pri" onClick={() => play()}>
                  <Icon name="play" /> Play
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
