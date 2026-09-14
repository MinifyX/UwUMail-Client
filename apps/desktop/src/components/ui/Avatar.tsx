import clsx from "clsx";
import { useState } from "react";
import type { AccountColor, Address } from "@/backend/types";
import { colorFor, initials } from "@/lib/format";
import { cachedLook, lookOfImage } from "@/lib/pictureLook";
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
  size?: "sm" | "list" | "md" | "lg";
  className?: string;
}

export function Avatar({ address, size = "md", className }: AvatarProps) {
  const color = COLOR_CLASSES[colorFor(address.email)];
  const picture = useSenderPicture(address.email);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // A picture that didn't load with CORS gets one more try without, it just can't be looked at then.
  const [withoutCors, setWithoutCors] = useState<string | null>(null);
  const shown = picture && picture.url !== failed ? picture : null;
  const cors = shown !== null && withoutCors !== shown.url;
  const ready = shown !== null && loaded === shown.url;
  // Filled in by onLoad before `ready` flips. Null when the pixels couldn't be read.
  const look = ready ? cachedLook(shown.url) : undefined;
  // Logos that cover the whole circle stay edge to edge; everything else sits on a plain backdrop.
  const fill = shown?.kind === "logo" && !look?.seeThrough;

  return (
    <span
      aria-hidden
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold",
        // Initials wait underneath until the picture is there, and come back if it can't load.
        !ready && [color.bg, color.text],
        size === "list" && "size-9 text-[12px]",
        size === "sm" && "size-7 text-[11px]",
        size === "md" && "size-10 text-[13px]",
        size === "lg" && "size-12 text-[15px]",
        className,
      )}
    >
      {!ready && initials(address)}
      {shown && (
        <span
          className={clsx(
            "absolute inset-0 grid place-items-center rounded-full transition-opacity duration-200",
            !fill && "ring-1 ring-inset",
            !fill && (look?.light ? "bg-[#2b2530] ring-white/10 dark:bg-[#3a3340]" : "bg-white ring-black/5"),
            ready ? "opacity-100" : "opacity-0",
          )}
        >
          <img
            key={cors ? "cors" : "plain"}
            src={shown.url}
            alt=""
            // Lets the canvas read the pixels; the engine serves pictures with a matching CORS header.
            crossOrigin={cors ? "anonymous" : undefined}
            draggable={false}
            onLoad={(event) => {
              lookOfImage(shown.url, event.currentTarget);
              setLoaded(shown.url);
            }}
            onError={() => (cors ? setWithoutCors(shown.url) : setFailed(shown.url))}
            className={clsx(
              fill ? "size-full object-cover" : "object-contain",
              !fill && (shown.kind === "logo" ? "size-[72%]" : "size-[62%]"),
            )}
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
