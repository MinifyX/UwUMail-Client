import { beforeEach, describe, expect, it } from "vitest";
import { CAMEOS, finishNyu, playFirstNyu, playNyu, REDUCED_DURATION, useNyuCameo } from "./cameo";

const T0 = 1_000_000;

beforeEach(() => {
  useNyuCameo.setState({ current: null, played: {} });
});

const current = () => useNyuCameo.getState().current;

describe("playing a cameo", () => {
  it("plays with full movement for its time", () => {
    expect(playNyu("sent", { level: "full", now: T0 })).toBe(true);
    expect(current()).toMatchObject({ name: "sent", still: false, duration: CAMEOS.sent.duration });
    expect(current()!.until).toBe(T0 + CAMEOS.sent.duration);
  });

  it("stays away while Nyu's animations are off", () => {
    expect(playNyu("sent", { level: "off", now: T0 })).toBe(false);
    expect(current()).toBeNull();
  });

  it("shows only the meaningful ones as a short still picture when reduced", () => {
    expect(playNyu("peek", { level: "reduced", now: T0 })).toBe(false);
    expect(playNyu("photos", { level: "reduced", now: T0 })).toBe(false);
    expect(playNyu("birthday", { level: "reduced", now: T0 })).toBe(true);
    expect(current()).toMatchObject({ name: "birthday", still: true, duration: REDUCED_DURATION });
  });

  it("waits for the cooldown of the same key", () => {
    expect(playNyu("peek", { level: "full", now: T0 })).toBe(true);
    expect(playNyu("peek", { level: "full", now: T0 + CAMEOS.peek.cooldown - 1 })).toBe(false);
    expect(playNyu("peek", { level: "full", now: T0 + CAMEOS.peek.cooldown })).toBe(true);
    // Another key of the same cameo counts on its own.
    expect(playNyu("friend", { level: "full", key: "friend:a@example.com", now: T0 + 20_000 })).toBe(true);
    expect(playNyu("friend", { level: "full", key: "friend:b@example.com", now: T0 + 40_000 })).toBe(true);
    expect(playNyu("friend", { level: "full", key: "friend:a@example.com", now: T0 + 60_000 })).toBe(false);
  });

  it("never lets a lesser one cut a more important one short, but replaces it once over", () => {
    playNyu("birthday", { level: "full", now: T0 });
    expect(playNyu("peek", { level: "full", now: T0 + 100 })).toBe(false);
    expect(playNyu("sent", { level: "full", now: T0 + 100 })).toBe(false);
    expect(current()!.name).toBe("birthday");
    expect(playNyu("sent", { level: "full", now: T0 + CAMEOS.birthday.duration })).toBe(true);
    // The same or a higher priority takes over at once.
    expect(playNyu("archived", { level: "full", now: T0 + CAMEOS.birthday.duration + 10 })).toBe(true);
    expect(current()!.name).toBe("archived");
  });

  it("plays the first choice that may play and keeps the hat", () => {
    playNyu("birthday", { level: "full", key: "birthday:leni", now: T0 });
    finishNyu(current()!.id);
    const played = playFirstNyu(
      [
        { name: "birthday", key: "birthday:leni" },
        { name: "peek", key: "peek", hat: "santa" },
      ],
      { level: "full", now: T0 + 5000 },
    );
    expect(played).toBe("peek");
    expect(current()).toMatchObject({ name: "peek", hat: "santa" });
    expect(playFirstNyu([{ name: "peek", key: "peek" }], { level: "off", now: T0 + 60_000 })).toBeNull();
  });

  it("finishes only the cameo it was asked to", () => {
    playNyu("sent", { level: "full", now: T0 });
    const first = current()!.id;
    playNyu("archived", { level: "full", now: T0 + 10 });
    finishNyu(first);
    expect(current()!.name).toBe("archived");
    finishNyu(current()!.id);
    expect(current()).toBeNull();
  });
});
