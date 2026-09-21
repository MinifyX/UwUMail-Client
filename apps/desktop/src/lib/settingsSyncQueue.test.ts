import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, type SettingsPatch, type SettingsValues } from "./settingsSync";
import { SettingsSyncQueue, type SaveOutcome, type SyncMeta, type SyncOptions } from "./settingsSyncQueue";

/** A server in memory that behaves like the settings extension. */
class FakeServer {
  state = 0;
  values: SettingsValues = {};
  offline = false;
  saves: { patch: SettingsPatch; ifInState?: string }[] = [];
  /** Keys refused with invalidProperties. */
  refuse = new Set<string>();

  async load() {
    if (this.offline) throw new Error("offline");
    return { state: String(this.state), values: structuredClone(this.values) };
  }

  async save(patch: SettingsPatch, ifInState?: string): Promise<SaveOutcome> {
    if (this.offline) throw new Error("offline");
    this.saves.push({ patch, ...(ifInState === undefined ? {} : { ifInState }) });
    if (ifInState !== undefined && ifInState !== String(this.state)) return { ok: false, type: "stateMismatch" };
    const refused = Object.keys(patch).filter((key) => this.refuse.has(key));
    if (refused.length > 0) return { ok: false, type: "invalidProperties", properties: refused };
    this.write(patch);
    return { ok: true, state: String(this.state) };
  }

  /** Another device writes. */
  write(patch: SettingsPatch) {
    this.values = applyPatch(this.values, patch);
    this.state += 1;
  }
}

class FakeDevice {
  values: SettingsValues;
  constructor(values: SettingsValues) {
    this.values = values;
  }
  read = () => structuredClone(this.values);
  apply = (patch: SettingsPatch) => {
    this.values = applyPatch(this.values, patch);
  };
}

class MemoryStorage {
  meta: SyncMeta | null = null;
  load = () => (this.meta ? structuredClone(this.meta) : null);
  save = (meta: SyncMeta) => {
    this.meta = structuredClone(meta);
  };
}

function queueFor(
  server: FakeServer,
  device: FakeDevice,
  storage = new MemoryStorage(),
  extra: Partial<SyncOptions> = {},
) {
  return new SettingsSyncQueue({
    account: "mini@uwumail.test",
    transport: { load: () => server.load(), save: (patch, state) => server.save(patch, state) },
    local: device,
    storage,
    signatures: true,
    debounceMs: 50,
    retryMs: 1000,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the settings sync queue", () => {
  it("unites both sides on the first start", async () => {
    const server = new FakeServer();
    server.write({ theme: "dark", "trustedSenders:@server.example": true });
    const device = new FakeDevice({ theme: "light", "trustedSenders:@local.example": true });
    await queueFor(server, device).start();
    expect(device.values).toEqual({
      theme: "dark",
      "trustedSenders:@server.example": true,
      "trustedSenders:@local.example": true,
    });
    expect(server.values).toEqual(device.values);
  });

  it("sends changes made here in one batch once they settle", async () => {
    const server = new FakeServer();
    const device = new FakeDevice({ theme: "light" });
    const queue = queueFor(server, device);
    await queue.start();
    server.saves = [];

    device.values = { ...device.values, theme: "dark", "linkDomains:a.example": true };
    await queue.localChanged();
    device.values = { ...device.values, tone: "neutral" };
    await queue.localChanged();
    expect(server.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]?.patch).toEqual({ theme: "dark", "linkDomains:a.example": true, tone: "neutral" });
    expect(server.values).toEqual(device.values);
  });

  it("takes what other devices wrote and doesn't answer its own echo", async () => {
    const server = new FakeServer();
    const device = new FakeDevice({ theme: "light", "linkDomains:old.example": true });
    const queue = queueFor(server, device);
    await queue.start();
    const loads = vi.spyOn(server, "load");

    // Our own write comes back as a push with the state we already have.
    await queue.remoteChanged(String(server.state));
    expect(loads).not.toHaveBeenCalled();

    server.write({ theme: "dark", "linkDomains:old.example": null });
    server.saves = [];
    await queue.remoteChanged(String(server.state));
    expect(device.values).toEqual({ theme: "dark" });
    // Taking the server's values over is not a change to send back.
    await queue.localChanged();
    await vi.advanceTimersByTimeAsync(60);
    expect(server.saves).toHaveLength(0);
  });

  it("keeps changes while offline, across a restart, and sends them later", async () => {
    const server = new FakeServer();
    const storage = new MemoryStorage();
    const device = new FakeDevice({ theme: "light" });
    const first = queueFor(server, device, storage);
    await first.start();

    server.offline = true;
    device.values = { ...device.values, theme: "dark", "trustedSenders:@a.example": true };
    await first.localChanged();
    await vi.advanceTimersByTimeAsync(60);
    expect(first.currentStatus()).toMatchObject({ phase: "error", problem: "offline", pending: 2 });
    first.stop();

    // Meanwhile another device removes nothing but adds an entry.
    server.offline = false;
    server.write({ "linkDomains:b.example": true });

    const second = queueFor(server, device, storage);
    await second.start();
    expect(server.values).toEqual({ theme: "dark", "trustedSenders:@a.example": true, "linkDomains:b.example": true });
    expect(device.values).toEqual(server.values);
    expect(second.currentStatus()).toMatchObject({ phase: "ok", pending: 0 });
  });

  it("tries again after a failure", async () => {
    const server = new FakeServer();
    const device = new FakeDevice({ theme: "light" });
    server.offline = true;
    const queue = queueFor(server, device);
    await queue.start();
    expect(queue.currentStatus().phase).toBe("error");
    server.offline = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.currentStatus().phase).toBe("ok");
    expect(server.values).toEqual({ theme: "light" });
  });

  it("merges and sends again when someone else wrote in between", async () => {
    const server = new FakeServer();
    const device = new FakeDevice({ theme: "light" });
    const queue = queueFor(server, device);
    await queue.start();

    // Another device writes, but its push hasn't arrived yet.
    server.write({ tone: "neutral", "linkDomains:x.example": true });
    device.values = { ...device.values, theme: "dark" };
    await queue.localChanged();
    await queue.flush();

    expect(server.saves.at(-2)).toMatchObject({ patch: { theme: "dark" } });
    expect(server.values).toEqual({ theme: "dark", tone: "neutral", "linkDomains:x.example": true });
    expect(device.values).toEqual(server.values);
  });

  it("keeps refused keys on this device and sends the rest", async () => {
    const server = new FakeServer();
    server.refuse.add("linkDomains:refused.example");
    const device = new FakeDevice({ theme: "light" });
    const queue = queueFor(server, device);
    await queue.start();

    device.values = { ...device.values, "linkDomains:refused.example": true, "linkDomains:fine.example": true };
    await queue.localChanged();
    await queue.flush();
    expect(server.values).toEqual({ theme: "light", "linkDomains:fine.example": true });
    expect(queue.currentStatus()).toMatchObject({ phase: "ok", refused: 1 });

    // A later merge doesn't take it away here just because the server lacks it.
    await queue.refresh();
    expect(device.values).toHaveProperty(["linkDomains:refused.example"], true);
  });

  it("doesn't send back what this device stored differently", async () => {
    const server = new FakeServer();
    const signature = { email: "", name: "Kurz", html: "<p onclick=x>Mini</p>", forNew: false, forReplies: false };
    server.write({ "signature:abc": signature });
    const device = new FakeDevice({});
    const cleaned = { ...signature, html: "<p>Mini</p>" };
    device.apply = (patch: SettingsPatch) => {
      const stored = "signature:abc" in patch ? { "signature:abc": cleaned } : {};
      device.values = applyPatch(device.values, { ...patch, ...stored });
      return stored;
    };
    const queue = queueFor(server, device);
    await queue.start();
    server.saves = [];
    await queue.localChanged();
    await vi.advanceTimersByTimeAsync(60);
    expect(server.saves).toHaveLength(0);
  });

  it("leaves signatures alone where they aren't kept locally", async () => {
    const server = new FakeServer();
    const signature = { email: "", name: "Kurz", html: "<p>Mini</p>", forNew: false, forReplies: false };
    server.write({ "signature:abc": signature });
    const device = new FakeDevice({ theme: "light" });
    const queue = queueFor(server, device, new MemoryStorage(), { signatures: false });
    await queue.start();
    expect(device.values).toEqual({ theme: "light" });
    expect(server.values).toHaveProperty(["signature:abc"]);
  });

  it("takes the server's lists as they are after another login", async () => {
    const server = new FakeServer();
    server.write({ "trustedSenders:@mine.example": true });
    const storage = new MemoryStorage();
    storage.meta = { account: "leni@uwumail.test", state: "4", pending: {}, refused: [], synced: true, lastSync: 1 };
    const device = new FakeDevice({ "trustedSenders:@theirs.example": true });
    await queueFor(server, device, storage, { onAccountSwitch: "server" }).start();
    expect(device.values).toEqual({ "trustedSenders:@mine.example": true });
    expect(server.values).toEqual({ "trustedSenders:@mine.example": true });
  });
});
