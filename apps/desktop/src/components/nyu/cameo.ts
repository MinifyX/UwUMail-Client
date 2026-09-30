import { create } from "zustand";
import type { Hat } from "./hats";
import { currentNyuLevel, type NyuLevel } from "./level";

/**
 * Nyu's cameos: a short scene (at most about two seconds) in a corner of the window when
 * something happens, played by `playNyu()` from anywhere and shown by <NyuStage/>. They never
 * take clicks, never move the layout, and one replaces the other instead of queueing up.
 */
export type CameoName =
  /** A mail was opened: Nyu pops up and reads along. */
  | "peek"
  /** A mail went out: the letter flies away, Nyu waves after it. */
  | "sent"
  /** Mail was archived: the box closes over the letter. */
  | "archived"
  /** Mail went into the trash: it drops into the bin, Nyu waves goodbye. */
  | "trashed"
  /** Mail was deleted for good: the lid shuts with a puff. */
  | "deleted"
  /** A mail from a contact whose birthday is today: party hat and confetti. */
  | "birthday"
  /** New mail from someone in the contacts: little hearts. */
  | "friend"
  /** A mail with photos attached: Nyu takes a picture too. */
  | "photos"
  /** Late at night: Nyu in its nightcap, yawning under the moon. */
  | "night";

export type { Hat } from "./hats";

export interface CameoSpec {
  /** How long it stays with full movement, in milliseconds. */
  duration: number;
  /** Shown (as a still picture) when Nyu's animations are reduced. */
  reduced: boolean;
  /** A scene only replaces one of the same or a lower priority. */
  priority: number;
  /** The same key doesn't play again before this many milliseconds. */
  cooldown: number;
}

const MINUTE = 60_000;

export const CAMEOS: Record<CameoName, CameoSpec> = {
  peek: { duration: 1300, reduced: false, priority: 0, cooldown: 12_000 },
  photos: { duration: 1500, reduced: false, priority: 1, cooldown: MINUTE },
  night: { duration: 1800, reduced: true, priority: 1, cooldown: 45 * MINUTE },
  friend: { duration: 1600, reduced: true, priority: 1, cooldown: 5 * MINUTE },
  sent: { duration: 1800, reduced: true, priority: 2, cooldown: 0 },
  archived: { duration: 1500, reduced: true, priority: 2, cooldown: 0 },
  trashed: { duration: 1500, reduced: true, priority: 2, cooldown: 0 },
  deleted: { duration: 1700, reduced: true, priority: 2, cooldown: 0 },
  birthday: { duration: 2000, reduced: true, priority: 3, cooldown: 12 * 60 * MINUTE },
};

/** A still picture stays this long at most. */
export const REDUCED_DURATION = 1400;

export interface Cameo {
  id: number;
  name: CameoName;
  hat?: Hat;
  /** Still picture, no movement. */
  still: boolean;
  /** Milliseconds it stays. */
  duration: number;
  /** When it is over (ms since the epoch). */
  until: number;
}

interface CameoState {
  current: Cameo | null;
  /** When each key last played. */
  played: Record<string, number>;
}

export const useNyuCameo = create<CameoState>(() => ({ current: null, played: {} }));

let nextId = 1;

export interface PlayOptions {
  /** What the cooldown counts under; the name by default. */
  key?: string;
  hat?: Hat;
  /** For tests: the level and the time instead of the real ones. */
  level?: NyuLevel;
  now?: number;
}

/** Plays a cameo if Nyu's animations allow it and nothing more important is on. Returns whether it plays. */
export function playNyu(name: CameoName, options: PlayOptions = {}): boolean {
  const spec = CAMEOS[name];
  const level = options.level ?? currentNyuLevel();
  if (level === "off" || (level === "reduced" && !spec.reduced)) return false;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  const now = options.now ?? Date.now();
  const key = options.key ?? name;
  const { current, played } = useNyuCameo.getState();
  const last = played[key];
  if (last !== undefined && now - last < spec.cooldown) return false;
  if (current && current.until > now && CAMEOS[current.name].priority > spec.priority) return false;
  const still = level === "reduced";
  const duration = still ? Math.min(spec.duration, REDUCED_DURATION) : spec.duration;
  useNyuCameo.setState({
    current: {
      id: nextId++,
      name,
      still,
      duration,
      until: now + duration,
      ...(options.hat ? { hat: options.hat } : {}),
    },
    played: { ...played, [key]: now },
  });
  return true;
}

/** Plays the first of several choices that may play now (see occasions.openCameos). */
export function playFirstNyu(
  choices: readonly { name: CameoName; key: string; hat?: Hat }[],
  options: Omit<PlayOptions, "key" | "hat"> = {},
): CameoName | null {
  for (const choice of choices) {
    if (playNyu(choice.name, { ...options, key: choice.key, ...(choice.hat ? { hat: choice.hat } : {}) })) {
      return choice.name;
    }
  }
  return null;
}

/** Takes the cameo away once it is over; only the one with this id, not a newer one. */
export function finishNyu(id: number): void {
  if (useNyuCameo.getState().current?.id === id) useNyuCameo.setState({ current: null });
}
