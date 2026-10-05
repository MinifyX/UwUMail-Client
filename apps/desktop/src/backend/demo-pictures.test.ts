import { describe, expect, it } from "vitest";
import { DemoBackend } from "./demo";

describe("the demo's sender pictures", () => {
  it("answers like a UwUMail server: contact photos, people's own pictures, then logos", async () => {
    const demo = new DemoBackend();
    const [book] = await demo.addressBooks();
    await demo.createContact({
      addressBookId: book!.id,
      given: "Mia",
      surname: "",
      organization: "",
      title: "",
      emails: [{ id: "e1", address: "Mia@pixelparts.example", kind: "work" }],
      phones: [],
      addresses: [],
      birthday: null,
      birthdayChanged: false,
      note: "",
      photo: "data:image/jpeg;base64,bWlh",
    });
    expect(await demo.getSenderPicture("mia@pixelparts.example")).toEqual({
      url: "data:image/jpeg;base64,bWlh",
      kind: "photo",
    });
    // Her colleagues get the company's logo; only logos are asked for for a contact's logo button.
    expect((await demo.getSenderPicture("shop@pixelparts.example"))?.kind).toBe("logo");
    expect((await demo.getSenderPicture("mia@pixelparts.example", { logo: true }))?.kind).toBe("logo");
    expect((await demo.getSenderPicture("kai@uwumail.example"))?.kind).toBe("photo");
    // Locally, only what the "server" has itself: no other company's logo.
    expect(await demo.getSenderPicture("shop@pixelparts.example", { local: true })).toBeNull();
    expect((await demo.getSenderPicture("hello@uwumail.example", { local: true }))?.kind).toBe("logo");
  });
});
