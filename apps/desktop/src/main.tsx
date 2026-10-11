import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "./styles/base.css";
import "./styles/screens.css";
import "./styles/player.css";
import { App } from "./App";
import { AppProvider } from "./state/app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
