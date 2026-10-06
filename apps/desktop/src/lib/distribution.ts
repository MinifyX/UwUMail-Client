import { useQuery } from "@tanstack/react-query";
import { backend, type Distribution } from "@/backend/backend";
import { nativeIos } from "@/backend/mobile";

/**
 * Whether UwUMail offers its own updates (settings, the Mac's menu): not in an App Store build,
 * which gets new versions from the store (docs/app-store.md), and not on the iPhone, where a new
 * version comes from wherever the app was installed from. Nothing while the answer is unknown.
 */
export function updatesInApp(distribution: Distribution | undefined, ios: boolean = nativeIos): boolean {
  return !ios && distribution === "direct";
}

export function useDistribution(): Distribution | undefined {
  return useQuery({ queryKey: ["distribution"], queryFn: () => backend().distribution(), staleTime: Infinity }).data;
}

export function useUpdatesInApp(): boolean {
  return updatesInApp(useDistribution());
}
