import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companyLogoFrom, dataUrlToBlob } from "@/backend/pictureBlobs";
import type { ContactRecord, SenderPicture, SenderPictureLookup } from "@/backend/types";
import { useSettings } from "@/state/settings";
import { contactPhotoFor, queryKeys, refreshSenderPictures, senderPictureKey, useSenderPicture } from "./queries";

const pictures: Record<string, SenderPicture> = {
  "kai@example.com": { url: "data:image/png;base64,a2Fp", kind: "photo" },
  "news@example.com": { url: "data:image/svg+xml;base64,PHN2Zy8+", kind: "logo" },
};

const fake = {
  getSenderPicture: vi.fn(async (email: string, _lookup?: SenderPictureLookup) => pictures[email] ?? null),
  contacts: vi.fn(async (): Promise<ContactRecord[]> => []),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const card = (address: string, photo: string | null, isGroup = false): ContactRecord => ({
  id: address,
  accountId: "acc",
  addressBookId: "b1",
  displayName: address,
  given: "",
  surname: "",
  organization: "",
  title: "",
  emails: [{ id: "e1", address, kind: "home" }],
  phones: [],
  addresses: [],
  birthday: null,
  note: "",
  photo,
  isGroup,
});

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("sender pictures", () => {
  beforeEach(() => {
    fake.getSenderPicture.mockClear();
    fake.contacts.mockClear();
    useSettings.setState({ senderPictures: true });
  });
  afterEach(cleanup);

  it("asks once per address, whatever its case and however many avatars show it", async () => {
    const { wrapper } = setup();
    const first = renderHook(() => useSenderPicture("Kai@Example.com"), { wrapper });
    const second = renderHook(() => useSenderPicture(" kai@example.com "), { wrapper });
    await waitFor(() => expect(first.result.current?.kind).toBe("photo"));
    expect(second.result.current?.url).toBe("data:image/png;base64,a2Fp");
    expect(fake.getSenderPicture).toHaveBeenCalledTimes(1);
    expect(fake.getSenderPicture).toHaveBeenCalledWith("kai@example.com", { local: false, fresh: false });
    // Another address of the same domain is its own question.
    const news = renderHook(() => useSenderPicture("news@example.com"), { wrapper });
    await waitFor(() => expect(news.result.current?.kind).toBe("logo"));
    expect(fake.getSenderPicture).toHaveBeenCalledTimes(2);
  });

  it("takes a loaded contact's own photo first, without loading the contacts", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(queryKeys.contacts, [card("Kai@example.com", "data:image/jpeg;base64,b3du")]);
    const { result } = renderHook(() => useSenderPicture("kai@example.com"), { wrapper });
    expect(result.current).toEqual({ url: "data:image/jpeg;base64,b3du", kind: "photo" });
    expect(fake.getSenderPicture).not.toHaveBeenCalled();
    // Nothing loaded: the address books aren't searched for an avatar.
    const other = setup();
    renderHook(() => useSenderPicture("kai@example.com"), { wrapper: other.wrapper });
    await waitFor(() => expect(fake.getSenderPicture).toHaveBeenCalledTimes(1));
    expect(fake.contacts).not.toHaveBeenCalled();
  });

  it("leaves out linked, oversized and group photos", () => {
    const contacts = [
      card("link@example.com", "https://photos.example.com/kai.jpg"),
      card("big@example.com", `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`),
      card("team@example.com", "data:image/png;base64,dGVhbQ==", true),
      card("page@example.com", "data:text/html;base64,PGgxPg=="),
    ];
    for (const address of ["link@example.com", "big@example.com", "team@example.com", "page@example.com"]) {
      expect(contactPhotoFor(contacts, address)).toBeNull();
    }
  });

  it("with company pictures off, asks only locally and shows only people", async () => {
    useSettings.setState({ senderPictures: false });
    const { wrapper } = setup();
    const kai = renderHook(() => useSenderPicture("kai@example.com"), { wrapper });
    const news = renderHook(() => useSenderPicture("news@example.com"), { wrapper });
    await waitFor(() => expect(kai.result.current?.kind).toBe("photo"));
    await waitFor(() => expect(fake.getSenderPicture).toHaveBeenCalledTimes(2));
    expect(news.result.current).toBeNull();
    expect(fake.getSenderPicture).toHaveBeenCalledWith("news@example.com", { local: true, fresh: false });
    expect(senderPictureKey("Kai@Example.com", true)).toEqual(["senderPicture", "kai@example.com", "local"]);
  });

  it("asks nothing for what isn't an address", () => {
    const { wrapper } = setup();
    for (const email of ["", "kai", "@example.com", "kai@"]) {
      const { result } = renderHook(() => useSenderPicture(email), { wrapper });
      expect(result.current).toBeNull();
    }
    expect(fake.getSenderPicture).not.toHaveBeenCalled();
  });

  it("asks again past the engine's memory after pictures changed", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useSenderPicture("kai@example.com"), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    await refreshSenderPictures(client);
    await waitFor(() => expect(fake.getSenderPicture).toHaveBeenCalledTimes(2));
    expect(fake.getSenderPicture).toHaveBeenLastCalledWith("kai@example.com", { local: false, fresh: true });
  });
});

describe("a company's logo for a contact", () => {
  it("reads data: logos without fetch and never takes a person's photo", async () => {
    const logo = await companyLogoFrom({ url: "data:image/svg+xml;base64,PHN2Zy8+", kind: "logo" });
    expect(logo?.type).toBe("image/svg+xml");
    expect(await logo?.text()).toBe("<svg/>");
    expect(await companyLogoFrom({ url: "data:image/png;base64,a2Fp", kind: "photo" })).toBeNull();
    expect(dataUrlToBlob("data:text/html,<h1>")).toBeNull();
    expect(dataUrlToBlob("data:image/png;base64,%%%")).toBeNull();
    expect((await dataUrlToBlob("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E")?.text()) ?? "").toBe("<svg/>");
  });
});
