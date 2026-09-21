import { create } from "zustand";
import { backend, BackendError } from "@/backend/backend";
import type { BackendEvent, Signature } from "@/backend/types";
import { quotableHtml } from "@/lib/safeHtml";
import {
  SIGNATURE_PREFIX,
  applyToSettings,
  isSignatureKey,
  isSyncable,
  settingsToValues,
  SYNCED_FIELDS,
  type SettingsPatch,
  type SettingsValues,
  type SyncedSettings,
} from "@/lib/settingsSync";
import { SettingsSyncQueue, type SyncMeta, type SyncStatus } from "@/lib/settingsSyncQueue";
import { useSettings } from "./settings";

/**
 * The app's end of the settings sync. One UwUMail account (the "Sync-Konto", see Settings →
 * Accounts) carries the settings that follow the account (lib/settingsSync), signatures
 * included: read when the app starts and whenever its server says they changed, and changes
 * made here go back, queued while offline. Everything else stays on this device.
 */

const STORAGE_KEY = "uwumail.settingsSync";

export interface AccountSyncState {
  /** The account whose server carries the settings, or null when nothing syncs. */
  accountId: string | null;
  status: SyncStatus | null;
  /** Accounts whose server offers it, as last asked. */
  candidates: string[];
  /** Signatures that stay on this device: too big for the server, or with pictures it can't take. */
  unsynced: string[];
  /** Counts up whenever signatures came from the server, so lists of them load again. */
  signaturesTaken: number;
}

export const useAccountSync = create<AccountSyncState>(() => ({
  accountId: null,
  status: null,
  candidates: [],
  unsynced: [],
  signaturesTaken: 0,
}));

function loadMeta(): SyncMeta | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SyncMeta) : null;
  } catch {
    return null;
  }
}

function saveMeta(meta: SyncMeta): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // The queue still holds for as long as the app runs.
  }
}

// -------------------------------------------------------------------- signatures

function signatureKey(id: string): string {
  return `${SIGNATURE_PREFIX}${id}`;
}

function signatureValue(signature: Signature) {
  return {
    email: signature.email,
    name: signature.name.slice(0, 100),
    html: signature.html,
    forNew: signature.forNew,
    forReplies: signature.forReplies,
  };
}

/**
 * Whether a signature can travel. Pictures go as `data:` URLs, which is how the editor adds
 * them; a `cid:` picture (pasted from a mail) has nothing to point at on another device.
 */
export function signatureTravels(signature: Signature): boolean {
  if (/\bcid:/i.test(signature.html)) return false;
  return isSyncable(signatureKey(signature.id), signatureValue(signature));
}

/**
 * Signature HTML from another device, made safe to keep: the composer's own cleaner, and
 * pictures only as embedded images.
 */
export function cleanSyncedSignature(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${quotableHtml(html)}</body>`, "text/html");
  for (const image of doc.body.querySelectorAll("img")) {
    if (!/^data:image\/(png|jpeg|gif|webp);/i.test(image.getAttribute("src") ?? "")) image.remove();
  }
  return doc.body.innerHTML;
}

async function readSignatures(): Promise<{ values: SettingsValues; unsynced: string[] }> {
  const values: SettingsValues = {};
  const unsynced: string[] = [];
  for (const signature of await backend().listSignatures()) {
    if (signatureTravels(signature)) values[signatureKey(signature.id)] = signatureValue(signature);
    else unsynced.push(signature.id);
  }
  return { values, unsynced };
}

/** Takes signatures from the server; returns the ones stored differently (cleaned). */
async function applySignatures(patch: SettingsPatch): Promise<SettingsPatch> {
  const stored: SettingsPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!isSignatureKey(key)) continue;
    const id = key.slice(SIGNATURE_PREFIX.length);
    if (value === null) {
      await backend()
        .deleteSignature(id)
        .catch((error: unknown) => {
          if (!(error instanceof BackendError && error.code === "not_found")) throw error;
        });
      continue;
    }
    const incoming = value as Omit<Signature, "id">;
    const html = cleanSyncedSignature(incoming.html);
    await backend().putSyncedSignature({ ...incoming, id, html });
    if (html !== incoming.html) stored[key] = { ...incoming, html };
  }
  if (Object.keys(patch).some(isSignatureKey)) {
    useAccountSync.setState((state) => ({ signaturesTaken: state.signaturesTaken + 1 }));
  }
  return stored;
}

// -------------------------------------------------------------------- protections

/**
 * Choices that switch a protection off: links open without the question, remote images load for
 * everyone. The server's copy could have been changed by someone else (a taken-over server), so
 * from there these only ever get stricter. Switching one off takes a choice on this device.
 */
const WEAKER: Partial<Record<keyof SyncedSettings, unknown>> = { linkConfirm: false, remoteImages: "always" };

/**
 * Splits what came from the server into what this device takes and the choices it keeps as they
 * are (with this device's value, so the queue doesn't see a change here to send back).
 */
export function holdBackWeakening(
  patch: SettingsPatch,
  settings: SyncedSettings,
): { take: SettingsPatch; kept: SettingsPatch } {
  const take: SettingsPatch = {};
  const kept: SettingsPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = key as keyof SyncedSettings;
    if (Object.hasOwn(WEAKER, key) && value === WEAKER[field] && settings[field] !== value) {
      kept[key] = settings[field];
    } else {
      take[key] = value;
    }
  }
  return { take, kept };
}

// -------------------------------------------------------------------- the queue

let queue: SettingsSyncQueue | null = null;
let unsubscribers: (() => void)[] = [];
let generation = 0;

/** Which account carries the settings: the chosen one, or the one it was, or the first that can. */
async function pickAccount(): Promise<string | null> {
  // Asked even when sync is off, so Settings can offer the accounts to switch it on with.
  const candidates = await backend()
    .settingsSyncAccounts()
    .catch(() => [] as string[]);
  useAccountSync.setState({ candidates });
  const choice = useSettings.getState().settingsSyncAccount;
  if (choice === "off") return null;
  const accounts = await backend().listAccounts();
  const exists = (id: string | undefined) => id !== undefined && accounts.some((account) => account.id === id);
  if (choice && exists(choice)) return choice;
  const previous = loadMeta()?.account;
  // Offline, the account it was stays: its queue may still hold changes.
  if (exists(previous) && (candidates.includes(previous!) || candidates.length === 0)) return previous!;
  return candidates[0] ?? null;
}

function stop(): void {
  queue?.stop();
  queue = null;
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

/** (Re)starts the settings sync, e.g. at start and when the chosen account changes. */
export async function startAccountSync(): Promise<void> {
  const run = ++generation;
  stop();
  const accountId = await pickAccount().catch(() => null);
  if (run !== generation) return;
  useAccountSync.setState({ accountId, status: null });
  if (!accountId) return;

  const engine = backend();
  const current = new SettingsSyncQueue({
    account: accountId,
    signatures: true,
    // Picking another of one's own accounts keeps what this device had, and adds it there.
    onAccountSwitch: "union",
    transport: {
      load: () => engine.loadUserSettings(accountId),
      save: (patch, ifInState) => engine.saveUserSettings(accountId, patch, ifInState),
    },
    local: {
      read: async () => {
        const signatures = await readSignatures();
        useAccountSync.setState({ unsynced: signatures.unsynced });
        return { ...settingsToValues(useSettings.getState()), ...signatures.values };
      },
      keep: () => new Set(useAccountSync.getState().unsynced.map(signatureKey)),
      apply: async (patch) => {
        const { take, kept } = holdBackWeakening(patch, useSettings.getState());
        useSettings.setState(applyToSettings(useSettings.getState(), take));
        return { ...kept, ...(await applySignatures(take)) };
      },
    },
    storage: { load: loadMeta, save: saveMeta },
    onStatus: (status) => {
      if (queue === current) useAccountSync.setState({ status });
    },
  });
  queue = current;

  unsubscribers.push(
    useSettings.subscribe((state, previous) => {
      if (SYNCED_FIELDS.some((field) => state[field] !== previous[field])) void current.localChanged();
    }),
    engine.subscribe((event: BackendEvent) => {
      if (event.type === "settings:changed" && event.accountId === accountId) {
        void current.remoteChanged(event.state);
      }
      // Back online: what waits can go now.
      if (
        event.type === "account:status" &&
        event.accountId === accountId &&
        event.status.state === "idle" &&
        current.currentStatus().phase === "error"
      ) {
        void current.refresh();
      }
    }),
  );
  await current.start();
}

/** Signatures changed on this device (saved or deleted in Settings). */
export function signaturesChangedHere(): void {
  void queue?.localChanged();
}

/** Restarts the sync when the choice of account changes. Call once. */
export function watchSyncAccountChoice(): () => void {
  return useSettings.subscribe((state, previous) => {
    if (state.settingsSyncAccount !== previous.settingsSyncAccount) void startAccountSync();
  });
}
