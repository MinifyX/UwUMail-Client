import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

/** A little flourish on top of the message. "sent" lets Nyu fly off with the mail. */
export type ToastEffect = "sent";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  effect?: ToastEffect;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, tone?: ToastTone, effect?: ToastEffect) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  show: (message, tone = "info", effect) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { id, message, tone, effect }] });
    setTimeout(() => get().dismiss(id), tone === "error" ? 7000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, tone?: ToastTone, effect?: ToastEffect) =>
  useToasts.getState().show(message, tone, effect);
