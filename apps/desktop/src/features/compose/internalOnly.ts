import { useServerAccountFeatures } from "../masked/useMasked";

/**
 * The domains mail from `accountId` may go to when its UwUMail server lets it send only to
 * addresses it hosts; null when it may send anywhere (or its server doesn't say). Read again
 * when the engine says the accounts changed, e.g. after the server switched it on or off.
 */
export function useInternalDomains(accountId: string): string[] | null {
  const { data: features } = useServerAccountFeatures();
  return features?.find((entry) => entry.accountId === accountId)?.internalDomains ?? null;
}
