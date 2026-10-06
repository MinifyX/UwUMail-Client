import { backend, consentRequired } from "@/backend/backend";
import type { AssistFeature } from "@/backend/types";
import { askAiConsent } from "@/state/aiConsent";

/** Destinations the person said "not now" to in this session: calls that run by themselves don't ask again. */
const declined = new Set<string>();

/** Forgets the "not now" answers (tests). */
export function forgetDeclinedConsents() {
  declined.clear();
}

/**
 * Runs a call of the assistant that sends mail to a model. When the engine refuses because the
 * person hasn't agreed to that destination yet (`consentRequired`), asks them in the consent
 * dialog; on "Allow" the consent is kept and the call runs once more, on "Not now" the refusal is
 * thrown on and nothing was sent.
 *
 * `automatic` is for calls the person didn't start by a click (appointments read whenever a mail
 * opens): after one "Not now" they don't ask again in this session.
 */
export async function withAiConsent<T>(
  features: AssistFeature[],
  call: () => Promise<T>,
  { automatic = false }: { automatic?: boolean } = {},
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const destination = consentRequired(error);
    if (!destination) throw error;
    if (automatic && declined.has(destination.destination)) throw error;
    const allowed = await askAiConsent(destination, features);
    if (!allowed) {
      declined.add(destination.destination);
      throw error;
    }
    declined.delete(destination.destination);
    await backend().grantAssistConsent(destination.destination, destination.host);
    return call();
  }
}

/**
 * Before something that sends mail by itself is switched on (auto-labels, appointments on every
 * mail, a UwUMail server's AI for the other mailboxes): asks for the consent to where `features`
 * would send the mail of `scope` (`"device"` or a UwUMail account id). True when it may be
 * switched on: allowed now, allowed before, or the mail stays on this device.
 */
export async function confirmAiDestination(scope: string, features: AssistFeature[]): Promise<boolean> {
  const state = await backend().assistDestination(scope, features[0] ?? "summarize");
  if (!state || state.granted) return true;
  const destination = { destination: state.destination, kind: state.kind, name: state.name, host: state.host };
  const allowed = await askAiConsent(destination, features);
  if (!allowed) return false;
  declined.delete(destination.destination);
  await backend().grantAssistConsent(destination.destination, destination.host);
  return true;
}
