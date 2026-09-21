/**
 * Keeps this device's settings and the server's in step: reads them when sync starts and when
 * the server says they changed, and sends changes made here, batched, once they settle.
 * Changes that can't be sent yet (offline, server away) wait in a queue that survives a restart.
 *
 * The same file lives in UwUMail-Webmail and in the UwUMail app. Keep both identical; what
 * differs (where settings live, how the server is reached) comes in through `SyncLocal`,
 * `SyncTransport` and `SyncStorage`.
 */

import {
  applyPatch,
  diffValues,
  isSignatureKey,
  mergeWithServer,
  sameValue,
  syncableValues,
  type SettingsPatch,
  type SettingsValues,
} from "./settingsSync";

/** How a write went. A failed request (offline, server away) throws instead. */
export type SaveOutcome =
  | { ok: true; state?: string }
  /** `type` is the JMAP error; `properties` the refused keys of `invalidProperties`. */
  | { ok: false; type: string; properties?: string[] };

export interface SyncTransport {
  load(): Promise<{ state: string; values: SettingsValues }>;
  /** Sets keys (`null` removes). With `ifInState`, only if nothing else was written since. */
  save(patch: SettingsPatch, ifInState?: string): Promise<SaveOutcome>;
}

export interface SyncLocal {
  /** This device's synced settings as keys. */
  read(): Promise<SettingsValues> | SettingsValues;
  /** Keys this device keeps to itself for now, e.g. a signature too big for the server. */
  keep?(): ReadonlySet<string>;
  /**
   * Takes what came from the server; `null` removes. Returns the keys that were stored other
   * than they came (e.g. signature HTML after cleaning), so that isn't mistaken for a change here.
   */
  apply(patch: SettingsPatch): Promise<SettingsPatch | void> | SettingsPatch | void;
}

/** What the queue remembers between starts. */
export interface SyncMeta {
  /** Which account this belongs to; another one starts over. */
  account: string;
  /** The server's state after the last read or write. */
  state: string | null;
  /** Changes made here that haven't reached the server. */
  pending: SettingsPatch;
  /** Keys the server refused. They stay on this device until they change here again. */
  refused: string[];
  /** Whether the first merge (union of lists) is done. */
  synced: boolean;
  lastSync: number | null;
}

export interface SyncStorage {
  load(): SyncMeta | null;
  save(meta: SyncMeta): void;
}

export type SyncProblem = "offline" | "failed";

export interface SyncStatus {
  phase: "syncing" | "ok" | "error";
  lastSync: number | null;
  problem?: SyncProblem;
  /** The server's own words, for the log and the curious. */
  detail?: string;
  /** How many changes are still waiting. */
  pending: number;
  /** How many keys the server refused (too big, full, not allowed); they stay on this device. */
  refused: number;
}

export interface SyncOptions {
  account: string;
  transport: SyncTransport;
  local: SyncLocal;
  storage: SyncStorage;
  /** Whether signature keys are part of this device's settings; if not, they are left alone. */
  signatures: boolean;
  /**
   * What happens to the lists here when the queue last ran for another account: `union` keeps
   * them and adds them to the server (the same person picked another account), `server` takes
   * the server's lists as they are (another person signed in on this device).
   */
  onAccountSwitch?: "union" | "server";
  onStatus?: (status: SyncStatus) => void;
  /** Quiet time after a change before it is sent. */
  debounceMs?: number;
  /** First wait before trying again after a failure; it doubles up to five minutes. */
  retryMs?: number;
  now?: () => number;
}

const MAX_RETRY_MS = 5 * 60_000;
/** How often a write that lost a race is merged and tried again in one go. */
const MAX_ATTEMPTS = 3;

class RequestFailed extends Error {}

export function emptyMeta(account: string): SyncMeta {
  return { account, state: null, pending: {}, refused: [], synced: false, lastSync: null };
}

export class SettingsSyncQueue {
  private readonly options: Required<Omit<SyncOptions, "onStatus">> & Pick<SyncOptions, "onStatus">;
  private meta: SyncMeta;
  /** This device's values as last seen, to tell what changed here. */
  private snapshot: SettingsValues | null = null;
  /** Every step runs after the one before, so a read never interleaves with a write. */
  private chain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  private stopped = false;
  private status: SyncStatus;

  constructor(options: SyncOptions) {
    this.options = {
      debounceMs: 800,
      retryMs: 15_000,
      now: () => Date.now(),
      onAccountSwitch: "union",
      ...options,
    };
    this.retryDelay = this.options.retryMs;
    const stored = options.storage.load();
    if (stored && stored.account === options.account) {
      this.meta = stored;
    } else {
      const switched = stored !== null && this.options.onAccountSwitch === "server";
      this.meta = { ...emptyMeta(options.account), synced: switched };
    }
    this.status = {
      phase: "syncing",
      lastSync: this.meta.lastSync,
      pending: Object.keys(this.meta.pending).length,
      refused: this.meta.refused.length,
    };
  }

  /** Reads the server and sends what waits. */
  start(): Promise<void> {
    // What is here now is the baseline: changes from here on are queued, even before the
    // server answers for the first time.
    void this.enqueue(async () => {
      this.snapshot ??= await this.readLocal();
    });
    return this.refresh();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  currentStatus(): SyncStatus {
    return this.status;
  }

  /** Something changed on this device: note it, and send it once things settle. */
  localChanged(): Promise<void> {
    const done = this.enqueue(async () => {
      if (await this.capture()) this.scheduleFlush();
    });
    return done;
  }

  /** The server says the settings changed. Our own write's state needs no second look. */
  remoteChanged(state?: string): Promise<void> {
    if (state !== undefined && state === this.meta.state && Object.keys(this.meta.pending).length === 0) {
      return this.chain;
    }
    return this.refresh();
  }

  /** Reads the server, merges, and sends what is left. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      this.setStatus({ phase: "syncing" });
      try {
        await this.pull();
        await this.push();
      } catch (error) {
        this.failed(error);
      }
    });
  }

  /** Sends what waits right now, without the quiet time. */
  flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    return this.enqueue(async () => {
      try {
        await this.push();
      } catch (error) {
        this.failed(error);
      }
    });
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.chain.then(() => (this.stopped ? undefined : step()));
    this.chain = run.catch(() => undefined);
    return this.chain;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.debounceMs);
  }

  private inScope(key: string): boolean {
    return this.options.signatures || !isSignatureKey(key);
  }

  private async readLocal(): Promise<SettingsValues> {
    const values = syncableValues(await this.options.local.read());
    return Object.fromEntries(Object.entries(values).filter(([key]) => this.inScope(key)));
  }

  private keep(): Set<string> {
    return new Set([...this.meta.refused, ...(this.options.local.keep?.() ?? [])]);
  }

  /** Adds what changed here since the last look to the queue. True when there was something. */
  private async capture(): Promise<boolean> {
    const now = await this.readLocal();
    const before = this.snapshot;
    this.snapshot = now;
    // Nothing to compare with yet: the first merge takes care of what is here.
    if (!before) return false;
    const changes = diffValues(before, now);
    const keys = Object.keys(changes);
    if (keys.length === 0) return false;
    this.meta.pending = { ...this.meta.pending, ...changes };
    // A refused key that changed here gets another chance.
    this.meta.refused = this.meta.refused.filter((key) => !(key in changes));
    this.save();
    this.setStatus({});
    return true;
  }

  private async pull(): Promise<void> {
    let server: { state: string; values: SettingsValues };
    try {
      server = await this.options.transport.load();
    } catch (error) {
      throw new RequestFailed(error instanceof Error ? error.message : String(error));
    }
    await this.capture();
    const local = this.snapshot ?? (await this.readLocal());
    const values = Object.fromEntries(
      Object.entries(syncableValues(server.values)).filter(([key]) => this.inScope(key)),
    );
    const merged = mergeWithServer({
      server: values,
      local,
      pending: this.meta.pending,
      firstSync: !this.meta.synced,
      keep: this.keep(),
    });
    const stored = Object.keys(merged.apply).length > 0 ? await this.options.local.apply(merged.apply) : undefined;
    this.snapshot = applyPatch(local, { ...merged.apply, ...(stored ?? {}) });
    this.meta = { ...this.meta, state: server.state, pending: merged.pending, synced: true };
    this.save();
  }

  private async push(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const batch = { ...this.meta.pending };
      if (Object.keys(batch).length === 0) {
        this.succeeded();
        return;
      }
      let outcome: SaveOutcome;
      try {
        outcome = await this.options.transport.save(batch, this.meta.state ?? undefined);
      } catch (error) {
        throw new RequestFailed(error instanceof Error ? error.message : String(error));
      }
      if (outcome.ok) {
        this.sent(batch, outcome.state ?? null);
        continue;
      }
      if (outcome.type === "stateMismatch" && attempt < MAX_ATTEMPTS) {
        // Someone else wrote in between: take their changes in, then send ours again.
        await this.pull();
        continue;
      }
      if (outcome.type === "invalidProperties") {
        const named = (outcome.properties ?? []).filter((key) => key in batch);
        this.refuse(named.length > 0 ? named : Object.keys(batch));
        continue;
      }
      if (outcome.type === "tooLarge" || outcome.type === "overQuota") {
        this.refuse(Object.keys(batch));
        continue;
      }
      throw new Error(outcome.type);
    }
  }

  /** The server has `batch`; what changed here meanwhile stays queued. */
  private sent(batch: SettingsPatch, state: string | null): void {
    const pending = { ...this.meta.pending };
    for (const [key, value] of Object.entries(batch)) {
      if (key in pending && sameValue(pending[key], value)) delete pending[key];
    }
    this.meta = { ...this.meta, pending, state, lastSync: this.options.now() };
    this.save();
  }

  private refuse(keys: string[]): void {
    const pending = { ...this.meta.pending };
    for (const key of keys) delete pending[key];
    this.meta = { ...this.meta, pending, refused: [...new Set([...this.meta.refused, ...keys])] };
    this.save();
  }

  private succeeded(): void {
    this.retryDelay = this.options.retryMs;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.meta = { ...this.meta, lastSync: this.options.now() };
    this.save();
    this.setStatus({ phase: "ok", problem: undefined, detail: undefined });
  }

  private failed(error: unknown): void {
    const offline = error instanceof RequestFailed;
    const detail = error instanceof Error ? error.message : String(error);
    this.setStatus({ phase: "error", problem: offline ? "offline" : "failed", detail });
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
  }

  private save(): void {
    this.options.storage.save(this.meta);
  }

  private setStatus(change: Partial<SyncStatus>): void {
    this.status = {
      ...this.status,
      ...change,
      lastSync: this.meta.lastSync,
      pending: Object.keys(this.meta.pending).length,
      refused: this.meta.refused.length,
    };
    this.options.onStatus?.(this.status);
  }
}
