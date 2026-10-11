import { useEffect, useRef } from "react";
import { api } from "./api";
import { Rail } from "./components/Rail";
import { Toasts } from "./components/Toasts";
import { Guide } from "./screens/Guide";
import { Home } from "./screens/Home";
import { Library } from "./screens/Library";
import { Live } from "./screens/Live";
import { MovieDetail } from "./screens/MovieDetail";
import { Multiview } from "./screens/Multiview";
import { Onboarding } from "./screens/Onboarding";
import { Player } from "./screens/Player";
import { Search } from "./screens/Search";
import { SeriesDetail } from "./screens/SeriesDetail";
import { Settings } from "./screens/Settings";
import { useApp, type Route } from "./state/app";
import { useSpatialNav } from "./state/useSpatialNav";

function isTyping(el: Element | null) {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

export function App() {
  const { route, navigate, back, sources, toast, sourceName } = useApp();
  const fullscreen = route.name === "player" || route.name === "multiview" || route.name === "onboarding";
  useSpatialNav(route.name !== "player" && route.name !== "multiview");

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        navigate({ name: "settings" });
        return;
      }
      if (fullscreen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(document.activeElement)) {
        if (e.key === "Escape") (document.activeElement as HTMLElement).blur();
        return;
      }
      const map: Record<string, Route> = {
        g: { name: "guide" },
        l: { name: "live" },
        h: { name: "home" },
        b: { name: "library" },
        m: { name: "library", tab: "movie" },
        s: { name: "library", tab: "series" },
        "/": { name: "search" },
      };
      const r = map[e.key.toLowerCase()];
      if (r) {
        e.preventDefault();
        navigate(r);
      } else if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, navigate, back]);

  // background refresh toasts
  const announced = useRef(new Set<string>());
  useEffect(() => {
    return api.on("source-progress", (p) => {
      if (route.name === "onboarding") return;
      if (p.phase === "done") {
        if (announced.current.delete(p.sourceId)) toast(`${sourceName(p.sourceId)} updated`, "good");
      } else if (!announced.current.has(p.sourceId)) {
        announced.current.add(p.sourceId);
        toast(`Updating ${sourceName(p.sourceId)}`);
      }
    });
  }, [route.name, toast, sourceName]);

  let screen: React.ReactNode;
  switch (route.name) {
    case "home":
      screen = <Home />;
      break;
    case "live":
      screen = <Live route={route} />;
      break;
    case "guide":
      screen = <Guide key={route.chip ?? ""} initialChip={route.chip} />;
      break;
    case "player":
      screen = <Player route={route} />;
      break;
    case "multiview":
      screen = <Multiview route={route} />;
      break;
    case "library":
      screen = <Library tab={route.tab ?? "movie"} />;
      break;
    case "movies":
      screen = <Library tab="movie" />;
      break;
    case "series":
      screen = <Library tab="series" />;
      break;
    case "movie":
      screen = <MovieDetail id={route.id} />;
      break;
    case "seriesDetail":
      screen = <SeriesDetail id={route.id} />;
      break;
    case "search":
      screen = <Search initial={route.q} />;
      break;
    case "settings":
      screen = <Settings section={route.section} />;
      break;
    case "onboarding":
      screen = <Onboarding firstRun={!sources?.length} />;
      break;
  }

  return (
    <div className={fullscreen ? "app bare" : "app"}>
      {fullscreen ? null : <Rail />}
      <main className="main-area">{screen}</main>
      <Toasts />
    </div>
  );
}
