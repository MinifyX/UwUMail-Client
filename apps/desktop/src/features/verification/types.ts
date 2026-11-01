/** Why a mail carries a code: what the sender wants it for. */
export type VerificationPurpose = "login" | "signup" | "confirm-email" | "reset-password" | "confirm-action" | "other";

/**
 * A sign-in code or link the server found in a mail (JMAP `VerificationCode/query`,
 * `Email/verification`). The app never looks for codes itself.
 */
export interface VerificationCode {
  id: string;
  emailId: string;
  /** The conversation of the mail; lets the list mark its row. */
  threadId?: string;
  kind: "otp" | "link";
  /** The code (one-time codes only). */
  code?: string;
  /** The link (sign-in links only). */
  url?: string;
  /** Where the code is for, e.g. `bank.example`. */
  origin: string;
  /** Who sent the mail, as the list names them. */
  sender: string;
  purpose: VerificationPurpose;
  /** `header`: the sender declared it (signed); `heuristic`: read from the text, origin unconfirmed. */
  source: "header" | "heuristic";
  /** Whether the system may offer it for autofill on `origin`. */
  autofill: boolean;
  /** When it stops working (ISO 8601). */
  expiresAt: string;
}
