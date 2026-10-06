import clsx from "clsx";
import { Icon, ICONS } from "@uwusuite/design";
import { useState } from "react";
import type { ContactRecord } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { useContactPhoto } from "./useContactPhoto";

const SIZES = {
  list: "size-9",
  lg: "size-16",
} as const;

/**
 * The contact's own picture when the card has one; otherwise the same avatar as in the mail. The
 * large one (an open contact) also asks Microsoft or Google for the photo they keep apart.
 */
export function ContactAvatar({ contact, size = "list" }: { contact: ContactRecord; size?: keyof typeof SIZES }) {
  const photo = useContactPhoto(contact, size === "lg");
  // A picture that can't be shown (a broken one) falls back to the avatar instead of a broken image.
  const [failed, setFailed] = useState<string | null>(null);
  if (photo && photo !== failed) {
    return (
      <img
        src={photo}
        alt=""
        draggable={false}
        onError={() => setFailed(photo)}
        className={clsx("shrink-0 rounded-full object-cover", SIZES[size])}
      />
    );
  }
  if (contact.isGroup) {
    return (
      <span
        aria-hidden
        className={clsx("grid shrink-0 place-items-center rounded-full bg-pink-tint text-pink-ink", SIZES[size])}
      >
        <Icon icon={ICONS.people} size={size === "lg" ? "xl" : "sm"} />
      </span>
    );
  }
  return (
    <Avatar
      address={{ name: contact.displayName, email: contact.emails[0]?.address ?? contact.displayName }}
      size={size === "lg" ? "lg" : "list"}
      className={size === "lg" ? "!size-16 !text-[20px]" : undefined}
    />
  );
}
