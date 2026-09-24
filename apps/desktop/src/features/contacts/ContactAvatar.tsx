import clsx from "clsx";
import { UsersRound } from "lucide-react";
import type { ContactRecord } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";

const SIZES = {
  list: "size-9",
  lg: "size-16",
} as const;

/** The contact's own picture when the card has one; otherwise the same avatar as in the mail. */
export function ContactAvatar({ contact, size = "list" }: { contact: ContactRecord; size?: keyof typeof SIZES }) {
  if (contact.photo) {
    return (
      <img
        src={contact.photo}
        alt=""
        draggable={false}
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
        <UsersRound className={size === "lg" ? "size-7" : "size-4"} />
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
