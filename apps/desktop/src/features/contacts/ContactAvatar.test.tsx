import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactRecord } from "@/backend/types";
import { ContactAvatar } from "./ContactAvatar";

const fake = {
  getSenderPicture: vi.fn(async () => null),
  contactPhoto: vi.fn(async () => null),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const card = (photo: string | null): ContactRecord => ({
  id: "k1",
  accountId: "acc",
  addressBookId: "b1",
  displayName: "Mia Sommer",
  given: "Mia",
  surname: "Sommer",
  organization: "",
  title: "",
  emails: [{ id: "e1", address: "mia@example.org", kind: "home" }],
  phones: [],
  addresses: [],
  birthday: null,
  note: "",
  photo,
  isGroup: false,
});

function renderAvatar(photo: string | null) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactAvatar contact={card(photo)} />
    </QueryClientProvider>,
  );
}

describe("a contact's picture", () => {
  afterEach(cleanup);

  it("shows the picture inside the card", () => {
    const { container } = renderAvatar("data:image/jpeg;base64,/9j/4AAQ");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });

  it("falls back to the avatar when the picture can't be shown", () => {
    const { container } = renderAvatar("data:image/jpeg;base64,broken");
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img[src^='data:image/jpeg']")).toBeNull();
  });
});
