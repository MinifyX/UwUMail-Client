import clsx from "clsx";
import { useState } from "react";
import type { AccountColor, Address } from "@/backend/types";
import { colorFor, initials } from "@/lib/format";
import { useSenderPicture } from "@/lib/queries";

export const COLOR_CLASSES: Record<AccountColor, { bg: string; text: string; dot: string }> = {
  pink: {
    bg: "bg-[#ffe4ef] dark:bg-[#3a1a2a]",
    text: "text-[#a3154f] dark:text-[#ffa3c4]",
    dot: "bg-[var(--uwu-account-pink)]",
  },
  violet: {
    bg: "bg-[#ede5ff] dark:bg-[#2a2142]",
    text: "text-[#5b32c7] dark:text-[#c4b1ff]",
    dot: "bg-[var(--uwu-account-violet)]",
  },
  sky: {
    bg: "bg-[#dff3fc] dark:bg-[#10293a]",
    text: "text-[#0b6591] dark:text-[#8fd6f8]",
    dot: "bg-[var(--uwu-account-sky)]",
  },
  mint: {
    bg: "bg-[#d8f5e8] dark:bg-[#123a2a]",
    text: "text-[#0b6e4c] dark:text-[#6ee7b7]",
    dot: "bg-[var(--uwu-account-mint)]",
  },
  amber: {
    bg: "bg-[#fdf0d6] dark:bg-[#3a2a0c]",
    text: "text-[#8a5606] dark:text-[#f5c453]",
    dot: "bg-[var(--uwu-account-amber)]",
  },
  coral: {
    bg: "bg-[#fde6e2] dark:bg-[#3d1d18]",
    text: "text-[#a8392a] dark:text-[#ffab9d]",
    dot: "bg-[var(--uwu-account-coral)]",
  },
};

interface AvatarProps {
  address: Address;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function Avatar({ address, size = "md", className }: AvatarProps) {
  const color = COLOR_CLASSES[colorFor(address.email)];
  const picture = useSenderPicture(address.email);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = picture && picture.url !== failed ? picture : null;
  return (
    <span
      aria-hidden
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold",
        color.bg,
        color.text,
        size === "sm" && "size-7 text-[11px]",
        size === "md" && "size-10 text-[13px]",
        size === "lg" && "size-12 text-[15px]",
        className,
      )}
    >
      {initials(address)}
      {shown && (
        // Initials stay underneath until the picture has loaded, and come back if it can't.
        <span
          className={clsx(
            "absolute inset-0 grid place-items-center rounded-full transition-opacity duration-200",
            shown.kind === "icon" && "bg-white ring-1 ring-black/5 ring-inset",
            loaded === shown.url ? "opacity-100" : "opacity-0",
          )}
        >
          <img
            src={shown.url}
            alt=""
            draggable={false}
            onLoad={() => setLoaded(shown.url)}
            onError={() => setFailed(shown.url)}
            className={shown.kind === "logo" ? "size-full object-cover" : "size-[62%] object-contain"}
          />
        </span>
      )}
    </span>
  );
}

export function AccountDot({ color, className }: { color: AccountColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-block size-2 shrink-0 rounded-full", COLOR_CLASSES[color].dot, className)}
    />
  );
}
