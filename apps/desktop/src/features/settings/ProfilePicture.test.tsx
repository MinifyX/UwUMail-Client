import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "@/backend/backend";
import type { ProfilePicture, ProfilePictureOptions, ProfilePicturePatch } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useToasts } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { ProfilePictureSettings } from "./ProfilePicture";
import { SettingsDialog } from "./SettingsDialog";

let options: ProfilePictureOptions | null = null;
let profile: ProfilePicture = { url: null, visibility: "server", sendFace: false, updated: null };

const fake = {
  kind: "jmap",
  listAccounts: vi.fn(async () => [{ id: "acc", email: "mini@uwumail.example", displayName: "Mini" }]),
  mailRulesAvailable: vi.fn(async () => false),
  ruleAccounts: vi.fn(async () => []),
  assistScopes: vi.fn(async () => []),
  serverAccountFeatures: vi.fn(async () => (options ? [{ accountId: "acc", masked: null, profile: options }] : [])),
  profilePicture: vi.fn(async (_accountId: string) => ({ ...profile })),
  setProfilePicture: vi.fn(async (_accountId: string, picture: Blob | null) => {
    profile = { ...profile, url: picture ? "blob:mini" : null };
    return { ...profile };
  }),
  updateProfilePicture: vi.fn(async (_accountId: string, patch: ProfilePicturePatch) => {
    if (patch.visibility === "public" && !options?.mayBePublic) throw new BackendError("forbidden", "no");
    profile = { ...profile, ...patch };
  }),
  getSenderPicture: vi.fn(async () => null),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderPage(node = <ProfilePictureSettings accountId="acc" options={options!} />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("profile picture settings", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    options = { maxSize: 10 * 1024 * 1024, mayBePublic: true };
    profile = { url: null, visibility: "server", sendFace: false, updated: null };
  });
  afterEach(() => {
    cleanup();
    act(() => useToasts.setState({ toasts: [] }));
  });

  it("is a settings page only where the server keeps profile pictures", async () => {
    options = null;
    const first = renderPage(<SettingsDialog />);
    act(() => useUi.getState().openSettings("appearance"));
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    await waitFor(() => expect(fake.serverAccountFeatures).toHaveBeenCalled());
    expect(within(nav).queryByRole("button", { name: "Profile picture" })).toBeNull();
    first.unmount();

    options = { maxSize: 1000, mayBePublic: true };
    renderPage(<SettingsDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Profile picture" }));
    expect(await screen.findByRole("radiogroup", { name: "Who sees it" })).toBeTruthy();
    act(() => useUi.getState().closeSettings());
  });

  it("sends the picture in mails only while it is public", async () => {
    renderPage();
    const face = await screen.findByRole("switch", { name: /Send my picture in mails/ });
    expect(face.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /^Everyone/ }));
    await waitFor(() => expect(fake.updateProfilePicture).toHaveBeenCalledWith("acc", { visibility: "public" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: /Send my picture in mails/ }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("switch", { name: /Send my picture in mails/ }));
    await waitFor(() => expect(fake.updateProfilePicture).toHaveBeenCalledWith("acc", { sendFace: true }));
  });

  it("says when the admin switched public pictures off", async () => {
    options = { maxSize: 1000, mayBePublic: false };
    renderPage();
    const everyone = await screen.findByRole("radio", { name: /^Everyone/ });
    expect(everyone.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Your admin switched public pictures off.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Nobody/ }).hasAttribute("disabled")).toBe(false);
  });

  it("uploads the cropped square and removes it again", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1200, height: 900, close: vi.fn() })),
    );
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      done: BlobCallback,
      type?: string,
    ) {
      done(new Blob([`${this.width}x${this.height}`], { type }));
    });
    try {
      renderPage();
      await screen.findByRole("radiogroup", { name: "Who sees it" });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
      fireEvent.change(input, { target: { files: [new File(["png"], "me.png", { type: "image/png" })] } });
      fireEvent.click(await screen.findByRole("button", { name: "Use picture" }));

      await waitFor(() => expect(fake.setProfilePicture).toHaveBeenCalledTimes(1));
      const sent = fake.setProfilePicture.mock.calls[0]![1]!;
      expect(sent.type).toBe("image/jpeg");
      expect(await sent.text()).toBe("512x512");
      expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);

      fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
      await waitFor(() => expect(fake.setProfilePicture).toHaveBeenLastCalledWith("acc", null));
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("explains a refusal of a public picture", async () => {
    options = { maxSize: 1000, mayBePublic: true };
    fake.updateProfilePicture.mockRejectedValueOnce(new BackendError("forbidden", "invalidProperties"));
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: /^Everyone/ }));
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((toast) => toast.message)).toContain(
        "Your admin switched public pictures off.",
      ),
    );
  });
});
