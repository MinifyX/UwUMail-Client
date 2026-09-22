import { Component, type ErrorInfo, type ReactNode } from "react";
import { translate } from "@/i18n";

interface State {
  error: Error | null;
}

/**
 * The last line when a part of the interface throws while rendering. Without it React unmounts the
 * whole tree and leaves an empty window that only a restart brings back; this keeps a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("UwUMail hit an error while drawing its window", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <div className="flex max-w-md flex-col gap-3 rounded-3xl border border-line bg-surface p-6 shadow-lg">
          <h1 className="text-[17px] font-bold">{text("crash.title", "Da ist etwas schiefgegangen")}</h1>
          <p className="text-[14px] text-muted">
            {text("crash.body", "Ein Teil von UwUMail ist beim Anzeigen abgestürzt. Neu laden bringt dich zurück.")}
          </p>
          <pre className="max-h-32 overflow-auto rounded-xl bg-canvas px-3 py-2 text-[12px] whitespace-pre-wrap text-faint">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="self-start rounded-full bg-pink-solid px-4 py-2 text-[14px] font-semibold text-on-pink hover:bg-pink-solid-hover"
          >
            {text("crash.reload", "Neu laden")}
          </button>
        </div>
      </div>
    );
  }
}

/** Translation with a fallback, because the crash may have come from the translations themselves. */
function text(key: string, fallback: string): string {
  try {
    const value = translate(key);
    return value && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}
