import { create } from "zustand";
import type { AiDestination, AssistFeature } from "@/backend/types";

export interface AiConsentQuestion {
  /** Where the mail would go. */
  destination: AiDestination;
  /** What it would be sent for: decides the list of what is sent. */
  features: AssistFeature[];
  answer: (allowed: boolean) => void;
}

interface AiConsentState {
  /** The open "may this mail go there?" question, and who waits for the answer. */
  pending: AiConsentQuestion | null;
}

export const useAiConsent = create<AiConsentState>()(() => ({ pending: null }));

/**
 * Asks the person whether the assistant may send mail to `destination` (App Review 5.1.2(i)).
 * Resolves with their answer; the safe default, closing the dialog, is no. The engine refuses to
 * send without the consent either way: this only asks.
 */
export function askAiConsent(destination: AiDestination, features: AssistFeature[]): Promise<boolean> {
  return new Promise((resolve) => {
    const current = useAiConsent.getState().pending;
    // The same question twice (a summary and a spam check at once): both wait for one answer.
    if (
      current &&
      current.destination.destination === destination.destination &&
      current.destination.host === destination.host
    ) {
      const earlier = current.answer;
      useAiConsent.setState({
        pending: {
          ...current,
          features: [...new Set([...current.features, ...features])],
          answer: (allowed) => {
            earlier(allowed);
            resolve(allowed);
          },
        },
      });
      return;
    }
    // Another question still open counts as "no"; only the newest one is on screen.
    current?.answer(false);
    useAiConsent.setState({ pending: { destination, features, answer: resolve } });
  });
}

export function answerAiConsent(allowed: boolean) {
  const { pending } = useAiConsent.getState();
  if (!pending) return;
  useAiConsent.setState({ pending: null });
  pending.answer(allowed);
}
