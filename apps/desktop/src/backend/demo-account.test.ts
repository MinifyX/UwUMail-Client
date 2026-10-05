import { describe, expect, it } from "vitest";
import { DemoBackend } from "./demo";

describe("DemoBackend: what the UwUMail server keeps for the person", () => {
  it("offers masked addresses and the profile picture only on the UwUMail mailbox", async () => {
    const demo = new DemoBackend();
    const features = await demo.serverAccountFeatures();
    expect(features.map((entry) => entry.accountId)).toEqual(["acc-private"]);
    expect(features[0]?.masked?.domains?.length).toBeGreaterThan(0);
    expect(features[0]?.profile?.mayBePublic).toBe(true);
    await expect(demo.maskedAddresses("acc-studio")).rejects.toMatchObject({ code: "not_supported" });
    await expect(demo.profilePicture("acc-studio")).rejects.toMatchObject({ code: "not_supported" });
  });

  it("makes, changes and lists masked addresses", async () => {
    const demo = new DemoBackend();
    const before = await demo.maskedAddresses("acc-private");
    const made = await demo.createMaskedAddress("acc-private", {
      description: "Shop",
      forDomain: "https://shop.example",
      url: null,
    });
    expect(made.state).toBe("enabled");
    await demo.updateMaskedAddress("acc-private", made.id, { state: "disabled" });
    const after = await demo.maskedAddresses("acc-private");
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((item) => item.id === made.id)?.state).toBe("disabled");
  });

  it("stores the profile picture and who sees it", async () => {
    const demo = new DemoBackend();
    expect((await demo.profilePicture("acc-private")).url).toBeNull();
    const stored = await demo.setProfilePicture("acc-private", new Blob(["x"], { type: "image/jpeg" }));
    expect(stored.url).toMatch(/^data:image\/jpeg;base64,/);
    await demo.updateProfilePicture("acc-private", { visibility: "public", sendFace: true });
    expect(await demo.profilePicture("acc-private")).toMatchObject({ visibility: "public", sendFace: true });
    expect((await demo.setProfilePicture("acc-private", null)).url).toBeNull();
  });

  it("shares a calendar with people of the server, and leaves one shared with it", async () => {
    const demo = new DemoBackend();
    const people = await demo.calendarPeople("acc-private");
    expect(people.map((person) => person.email)).toContain("kai@uwumail.example");
    const sport = (await demo.calendars()).find((calendar) => calendar.name === "Sport")!;
    expect(sport.mayShare).toBe(true);
    await demo.shareCalendar(sport.id, "p-kai", "read");
    expect((await demo.calendars()).find((calendar) => calendar.id === sport.id)?.sharedWith).toEqual({
      "p-kai": "read",
    });
    await demo.shareCalendar(sport.id, "p-kai", null);
    expect((await demo.calendars()).find((calendar) => calendar.id === sport.id)?.sharedWith).toEqual({});

    const shared = (await demo.calendars()).find((calendar) => calendar.sharedBy)!;
    expect(shared.mayShare).toBeFalsy();
    await expect(demo.shareCalendar(shared.id, "p-kai", "read")).rejects.toThrow();
    await demo.deleteCalendar(shared.id);
    expect((await demo.calendars()).some((calendar) => calendar.id === shared.id)).toBe(false);
  });

  it("keeps a contact's new picture and takes it off again", async () => {
    const demo = new DemoBackend();
    const contact = (await demo.contacts())[0]!;
    const photo = "data:image/jpeg;base64,/9j/AA==";
    const input = {
      addressBookId: contact.addressBookId,
      given: contact.given,
      surname: contact.surname,
      organization: contact.organization,
      title: contact.title,
      emails: contact.emails,
      phones: contact.phones,
      addresses: contact.addresses,
      birthday: contact.birthday,
      birthdayChanged: false,
      note: contact.note,
    };
    await demo.updateContact(contact.id, { ...input, photo });
    expect((await demo.contacts()).find((c) => c.id === contact.id)?.photo).toBe(photo);
    await demo.updateContact(contact.id, input);
    expect((await demo.contacts()).find((c) => c.id === contact.id)?.photo).toBe(photo);
    await demo.updateContact(contact.id, { ...input, photo: null });
    expect((await demo.contacts()).find((c) => c.id === contact.id)?.photo).toBeNull();
  });
});
