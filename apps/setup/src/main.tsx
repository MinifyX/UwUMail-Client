import "@fontsource-variable/manrope";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

document.documentElement.lang = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
