import "./styles.css";
import { applyAppearance, resolveAppearance } from "@uwusuite/design";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

document.documentElement.lang = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
// Installers are always light (the package's docs/window.md); contrast and motion follow the system.
applyAppearance(resolveAppearance({ theme: "light" }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
