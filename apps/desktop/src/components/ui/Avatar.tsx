import clsx from "clsx";
import type { AccountColor, Address } from "@/backend/types";
import { colorFor, initials } from "@/lib/format";

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
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        color.bg,
        color.text,
        size === "sm" && "size-7 text-[11px]",
        size === "md" && "size-10 text-[13px]",
        size === "lg" && "size-12 text-[15px]",
        className,
      )}
    >
      {initials(address)}
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
