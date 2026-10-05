import { useQuery } from "@tanstack/react-query";
import { backend } from "@/backend/backend";
import type { ContactRecord } from "@/backend/types";
import { queryKeys } from "@/lib/queries";

/**
 * The picture a contact has: the one inside its card, or for Microsoft and Google, whose photo
 * lives apart from the contact, the one fetched when the contact opens (`enabled`). Never for the
 * whole list: one request per contact would be too many.
 */
export function useContactPhoto(contact: ContactRecord | null, enabled: boolean): string | null {
  const remote = Boolean(enabled && contact && !contact.photo && contact.remotePhoto);
  const { data } = useQuery({
    queryKey: queryKeys.contactPhoto(contact?.id ?? ""),
    queryFn: () => backend().contactPhoto(contact!.id),
    enabled: remote,
    staleTime: 10 * 60_000,
  });
  if (!contact) return null;
  return contact.photo ?? (remote ? (data ?? null) : null);
}
