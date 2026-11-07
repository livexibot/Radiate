import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "./styles/base.css";
import "./styles/screens.css";
import "./styles/player.css";
import { App } from "./App";
import { AppearanceProvider, applyCachedAppearance } from "./plugins/host";
import { floatId } from "./reactor/float";
import { ReactorFloat } from "./reactor/ReactorFloat";
import { AppProvider } from "./state/app";

applyCachedAppearance();

// A reactor's own window over mpv shows only its box.
const reactorBox = floatId(location.hash);

createRoot(document.getElementById("root")!).render(
  reactorBox ? (
    <StrictMode>
      <ReactorFloat id={reactorBox} />
    </StrictMode>
  ) : (
    <StrictMode>
      <AppProvider>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </AppProvider>
    </StrictMode>
  ),
);
