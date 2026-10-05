import { useQuery } from "@tanstack/react-query";
import { backend, BackendError } from "@/backend/backend";
import { translate } from "@/i18n";
import { queryKeys } from "@/lib/queries";

/**
 * Per mailbox on a UwUMail server, whether it makes masked addresses and keeps a profile picture;
 * the settings show their pages only for those.
 */
export function useServerAccountFeatures() {
  return useQuery({
    queryKey: queryKeys.serverAccountFeatures,
    queryFn: () => backend().serverAccountFeatures(),
    staleTime: 5 * 60_000,
  });
}

export function useMaskedAddresses(accountId: string) {
  return useQuery({
    queryKey: queryKeys.maskedAddresses(accountId),
    queryFn: () => backend().maskedAddresses(accountId),
  });
}

/** What went wrong, in the reader's language: the server's own words are for administrators. */
export function maskedErrorText(error: unknown): string {
  const code = error instanceof BackendError ? error.code : "internal";
  switch (code) {
    case "forbidden":
      return translate("masked.error.forbidden");
    case "invalid_input":
      return translate("masked.error.invalid");
    case "not_found":
      return translate("masked.error.notFound");
    case "connection_failed":
      return translate("masked.error.connection");
    case "auth_failed":
    case "sign_in_again":
      return translate("masked.error.signedOut");
    default:
      return translate("masked.error.generic");
  }
}
