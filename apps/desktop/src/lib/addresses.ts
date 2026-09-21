import type { Address, Message } from "@/backend/types";
import { visibleText } from "./links";

export type AddressRole = "from" | "replyTo" | "to" | "cc" | "bcc";

export interface AddressRow {
  role: AddressRole;
  addresses: Address[];
}

const sameAddresses = (a: Address[], b: Address[]) => {
  const key = (list: Address[]) =>
    list
      .map((address) => address.email.toLowerCase())
      .sort()
      .join(",");
  return key(a) === key(b);
};

/**
 * The address lines of a message's full header: From always, Reply-To only when it goes somewhere
 * else, To, and Cc/Bcc when there are any.
 */
export function addressRows(message: Pick<Message, "from" | "replyTo" | "to" | "cc" | "bcc">): AddressRow[] {
  const rows: AddressRow[] = [{ role: "from", addresses: [message.from] }];
  if (message.replyTo.length > 0 && !sameAddresses(message.replyTo, [message.from])) {
    rows.push({ role: "replyTo", addresses: message.replyTo });
  }
  if (message.to.length > 0) rows.push({ role: "to", addresses: message.to });
  if (message.cc.length > 0) rows.push({ role: "cc", addresses: message.cc });
  if (message.bcc && message.bcc.length > 0) rows.push({ role: "bcc", addresses: message.bcc });
  return rows;
}

/**
 * "Name <address>", safe to show: a sender picks their own display name, so invisible and
 * direction-changing characters in it are shown instead of obeyed.
 */
export function fullAddress(address: Address): string {
  const email = visibleText(address.email);
  const name = visibleText(address.name?.trim() ?? "");
  return name && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email;
}
