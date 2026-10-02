import "@fontsource-variable/rubik";
import "@fontsource-variable/dm-sans";
import "./styles/app.css";
import "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { loadBackend } from "./backend/backend";
import { applyUiFont, loadMailFont } from "./lib/fonts";
import { useSettings } from "./state/settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { startAccountSync, watchSyncAccountChoice } from "./state/accountSync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// The chosen font before the first paint; mails get it as a data: file, loaded right away.
const chooseFont = (font: Parameters<typeof applyUiFont>[0]) => {
  applyUiFont(font);
  loadMailFont(font).catch(() => undefined);
};
chooseFont(useSettings.getState().font);
useSettings.subscribe((state, previous) => {
  if (state.font !== previous.font) chooseFont(state.font);
});

await loadBackend();
// The settings that follow the account come from its UwUMail server, see state/accountSync.
void startAccountSync();
watchSyncAccountChoice();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
