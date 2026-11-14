import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

/** A little flourish on top of the message. "sent" lets Nyu fly off with the mail. */
export type ToastEffect = "sent";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Milliseconds until it goes away by itself. */
  duration?: number;
  /** Counts the seconds down to this time (ISO 8601), e.g. until a held-back mail goes. */
  countdownTo?: string;
}

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  effect?: ToastEffect;
  action?: ToastAction;
  countdownTo?: string;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, tone?: ToastTone, effect?: ToastEffect, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
  /** Holds a toast while the pointer or focus is on it; a countdown keeps running. */
  pause: (id: number) => void;
  /** Gives a held toast its full time again. */
  resume: (id: number) => void;
}

let nextId = 1;
/** Each toast's time and its running timer (none while held). */
const timers = new Map<number, { ms: number; timer?: ReturnType<typeof setTimeout> }>();

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (message, tone = "info", effect, options = {}) => {
    const id = nextId++;
    const { action, countdownTo } = options;
    set({ toasts: [...get().toasts.slice(-3), { id, message, tone, effect, action, countdownTo }] });
    const ms = options.duration ?? (tone === "error" ? 7000 : 3500);
    timers.set(id, { ms, timer: setTimeout(() => get().dismiss(id), ms) });
    return id;
  },
  dismiss: (id) => {
    clearTimeout(timers.get(id)?.timer);
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  pause: (id) => {
    const entry = timers.get(id);
    // The undo toast of a held-back mail lives exactly as long as the mail waits.
    if (!entry || get().toasts.find((t) => t.id === id)?.countdownTo) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  },
  resume: (id) => {
    const entry = timers.get(id);
    if (entry && !entry.timer) entry.timer = setTimeout(() => get().dismiss(id), entry.ms);
  },
}));

/** Shows a toast and returns its id, e.g. to dismiss it early. */
export const toast = (message: string, tone?: ToastTone, effect?: ToastEffect, options?: ToastOptions) =>
  useToasts.getState().show(message, tone, effect, options);
