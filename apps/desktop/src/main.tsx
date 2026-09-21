import "@fontsource-variable/manrope";
import "./styles/app.css";
import "./i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { loadBackend } from "./backend/backend";
import { startAccountSync, watchSyncAccountChoice } from "./state/accountSync";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

await loadBackend();
// The settings that follow the account come from its UwUMail server, see state/accountSync.
void startAccountSync();
watchSyncAccountChoice();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
