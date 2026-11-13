import { AvatarBlob } from "@uwusuite/design";
import clsx from "clsx";
import { useState } from "react";
import type { AccountColor, Address } from "@/backend/types";
import { cachedLook, lookOfImage } from "@/lib/pictureLook";
import { useSenderPicture } from "@/lib/queries";

/** The account dot per colour, from the package's account tokens. */
export const COLOR_CLASSES: Record<AccountColor, string> = {
  pink: "bg-account-pink",
  violet: "bg-account-violet",
  sky: "bg-account-sky",
  mint: "bg-account-mint",
  amber: "bg-account-amber",
  coral: "bg-account-coral",
};

interface AvatarProps {
  address: Address;
  size?: "xs" | "sm" | "list" | "md" | "lg";
  className?: string;
}

export function Avatar({ address, size = "md", className }: AvatarProps) {
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
  // People's pictures and logos that cover the whole circle stay edge to edge; everything else
  // sits on a plain backdrop.
  const fill = shown?.kind === "photo" || (shown?.kind === "logo" && !look?.seeThrough);

  return (
    <span
      aria-hidden
      className={clsx(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        size === "xs" && "size-5",
        size === "list" && "size-9",
        size === "sm" && "size-7",
        size === "md" && "size-10",
        size === "lg" && "size-12",
        className,
      )}
    >
      {/* The blob waits underneath until the picture is there, and comes back if it can't load. */}
      {!ready && <AvatarBlob seed={address.email} />}
      {shown && (
        <span
          className={clsx(
            "absolute inset-0 grid grid-cols-1 grid-rows-1 place-items-center rounded-full transition-opacity duration-200",
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
    <span aria-hidden className={clsx("inline-block size-2 shrink-0 rounded-full", COLOR_CLASSES[color], className)} />
  );
}
