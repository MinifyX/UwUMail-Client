import { describe, expect, it } from "vitest";
import { DemoBackend } from "./demo";

/** A wall time `days` from today's midnight, like the calendar page asks for ranges. */
function day(days: number, time = "00:00:00") {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days));
  return `${date.toISOString().slice(0, 10)}T${time}`;
}

describe("DemoBackend calendar", () => {
  it("has calendars for the UwUMail server account only", async () => {
    const demo = new DemoBackend();
    const calendars = await demo.calendars();
    expect(calendars.map((c) => c.accountId)).toEqual(["acc-private", "acc-private", "acc-private"]);
    expect(calendars.filter((c) => c.isDefault)).toHaveLength(1);
    expect(calendars.some((c) => !c.mayWrite)).toBe(true);
    const accounts = await demo.calendarAccounts();
    expect(accounts.find((a) => a.accountId === "acc-private")?.source).toBe("jmap");
    expect(accounts.find((a) => a.accountId === "acc-studio")).toMatchObject({ source: null });
    await expect(demo.createCalendar({ accountId: "acc-studio", name: "Nope", color: null })).rejects.toThrow();
  });

  it("expands the weekly series and shows all-day events up to the next midnight", async () => {
    const demo = new DemoBackend();
    const events = await demo.calendarEvents(day(0), day(56), "Europe/Berlin");
    const yoga = events.filter((e) => e.title === "Yoga");
    expect(yoga).toHaveLength(8);
    expect(new Set(yoga.map((e) => e.eventId)).size).toBe(1);
    expect(yoga[0]!.id).toBe(`${yoga[0]!.eventId}#${yoga[0]!.recurrenceId}`);
    expect(yoga[0]!.recurrence).toMatchObject({ frequency: "weekly", interval: 1 });
    expect(yoga[1]!.start.slice(11)).toBe("18:00:00");

    const allDay = events.filter((e) => e.allDay);
    expect(allDay.length).toBeGreaterThan(0);
    for (const event of allDay) {
      expect(event.start.endsWith("T00:00:00") && event.end.endsWith("T00:00:00")).toBe(true);
      expect(event.timeZone).toBeNull();
    }
    expect(events.find((e) => e.calendarId === "acc-private:holidays")?.readOnly).toBe(true);
    await expect(demo.calendarEvents(day(0), day(500), "Europe/Berlin")).rejects.toThrow(/400/);
  });

  it("creates, changes and deletes events and single occurrences", async () => {
    const demo = new DemoBackend();
    const heard: string[] = [];
    demo.subscribe((event) => heard.push(event.type));
    const input = {
      calendarId: "acc-private:personal",
      title: "Standup",
      description: "",
      location: "",
      allDay: false,
      start: day(1, "09:00:00"),
      end: day(1, "09:15:00"),
      timeZone: "Europe/Berlin",
      recurrence: { frequency: "daily" as const, interval: 1, byDay: null, until: null, count: 5 },
    };
    const id = await demo.createEvent(input);
    expect(heard).toContain("calendar:changed");
    const standups = () =>
      demo.calendarEvents(day(0), day(30), "Europe/Berlin").then((all) => all.filter((e) => e.eventId === id));
    expect(await standups()).toHaveLength(5);

    await demo.updateEvent(id, { ...input, title: "Daily", recurrence: { ...input.recurrence, count: 3 } });
    expect((await standups()).map((e) => e.title)).toEqual(["Daily", "Daily", "Daily"]);

    await demo.deleteEvent((await standups())[1]!.id, "occurrence");
    expect(await standups()).toHaveLength(2);
    await demo.deleteEvent((await standups())[0]!.id, "series");
    expect(await standups()).toHaveLength(0);

    await expect(demo.createEvent({ ...input, calendarId: "acc-private:holidays" })).rejects.toThrow(/read-only/);
    await expect(demo.createEvent({ ...input, end: day(0, "08:00:00") })).rejects.toThrow(/before/);
  });

  it("manages calendars", async () => {
    const demo = new DemoBackend();
    const created = await demo.createCalendar({ name: " Uni ", color: "#3b82f6" });
    expect(created).toMatchObject({ name: "Uni", accountId: "acc-private", mayWrite: true, isDefault: false });
    await demo.updateCalendar(created.id, { isVisible: false, color: null });
    await demo.setDefaultCalendar(created.id);
    const calendars = await demo.calendars();
    expect(calendars.find((c) => c.id === created.id)).toMatchObject({
      isVisible: false,
      color: null,
      isDefault: true,
    });
    expect(calendars.filter((c) => c.isDefault)).toHaveLength(1);
    await demo.deleteCalendar(created.id);
    expect((await demo.calendars()).some((c) => c.id === created.id)).toBe(false);
    await expect(demo.deleteCalendar("acc-private:holidays")).rejects.toThrow();
  });
});

describe("DemoBackend mail rules", () => {
  it("keeps one script for the UwUMail server account", async () => {
    const demo = new DemoBackend();
    expect(await demo.ruleAccounts()).toEqual(["acc-private"]);
    const rules = await demo.mailRules();
    expect(rules.active).toBe(true);
    expect(rules.script).toContain("# uwumail-rules: ");
    expect(rules.script).toContain('fileinto :mailboxid "acc-private:receipts"');
    const json = rules.script!.split("\n").find((line) => line.startsWith("# uwumail-rules: "))!;
    expect(JSON.parse(json.slice("# uwumail-rules: ".length)).rules).toHaveLength(2);

    await demo.saveMailRules('require ["fileinto"];\nif true {\n    stop;\n}\n', "acc-private");
    expect((await demo.mailRules("acc-private")).script).toContain("if true");
    await expect(demo.mailRules("acc-studio")).rejects.toThrow(/UwUMail server/);
  });

  it("reports what the server can't run", async () => {
    const demo = new DemoBackend();
    expect(await demo.validateMailRules("if true {\n    keep;\n}\n")).toBeNull();
    expect(await demo.validateMailRules('if true {\n    vacation "away";\n}\n')).toMatch(/vacation/);
    expect(await demo.validateMailRules("if true {\n    keep;\n")).toMatch(/missing/);
    // Braces inside strings and comments don't count.
    expect(await demo.validateMailRules('# {\nif header :contains "subject" "}" {\n    keep;\n}\n')).toBeNull();
    await expect(demo.saveMailRules("}")).rejects.toThrow();
  });
});

describe("DemoBackend folders", () => {
  it("creates, nests, renames and deletes folders like the engine", async () => {
    const demo = new DemoBackend();
    const id = await demo.createFolder({ accountId: "acc-private", name: "  Reisen ", parentId: null });
    const child = await demo.createFolder({ name: "Japan", parentId: id });

    let folders = await demo.listFolders("acc-private");
    expect(folders.find((f) => f.id === id)).toMatchObject({ name: "Reisen", parentId: null, role: null });
    expect(folders.find((f) => f.id === child)).toMatchObject({ accountId: "acc-private", parentId: id });

    await expect(demo.createFolder({ accountId: "acc-private", name: "reisen", parentId: null })).rejects.toThrow(
      /already/,
    );
    await expect(demo.createFolder({ accountId: "acc-private", name: "a/b", parentId: null })).rejects.toThrow();
    await expect(demo.createFolder({ accountId: "acc-private", name: "   ", parentId: null })).rejects.toThrow();
    await expect(demo.createFolder({ accountId: "acc-private", name: "x\ny", parentId: null })).rejects.toThrow();
    await expect(demo.createFolder({ name: "Nowhere", parentId: null })).rejects.toThrow(/mailbox/);

    await demo.renameFolder(id, "Urlaub");
    folders = await demo.listFolders("acc-private");
    expect(folders.find((f) => f.id === child)?.path).toBe("Urlaub/Japan");

    await expect(demo.deleteFolder(id)).rejects.toThrow(/folders inside/);
    await expect(demo.renameFolder("acc-private:inbox", "Post")).rejects.toThrow();
    await expect(demo.deleteFolder("acc-private:trash")).rejects.toThrow();
    await demo.deleteFolder(child);
    await demo.deleteFolder(id);
    expect((await demo.listFolders("acc-private")).some((f) => f.id === id)).toBe(false);
  });

  it("moves a deleted folder's mail into the trash", async () => {
    const demo = new DemoBackend();
    const before = await demo.listFolders("acc-private");
    const receipts = before.find((f) => f.id === "acc-private:projects-uwumail-bugs")!;
    const trashBefore = before.find((f) => f.role === "trash")!.total;
    expect(receipts.total).toBeGreaterThan(0);

    await demo.deleteFolder(receipts.id);
    const after = await demo.listFolders("acc-private");
    expect(after.find((f) => f.role === "trash")!.total).toBe(trashBefore + receipts.total);
  });

  it("empties only the trash and junk and says how many went", async () => {
    const demo = new DemoBackend();
    await expect(demo.emptyFolder("acc-private:inbox")).rejects.toThrow(/trash/);
    const inbox = await demo.listThreads({
      view: { kind: "folder", accountId: "acc-private", folderId: "acc-private:inbox" },
      filter: "all",
      conversations: false,
      limit: 2,
    });
    await demo.trash(inbox.threads.map((thread) => thread.id.slice(2)));
    const trash = (await demo.listFolders("acc-private")).find((f) => f.role === "trash")!;
    expect(trash.total).toBe(2);
    expect(await demo.emptyFolder(trash.id)).toBe(2);
    expect(await demo.emptyFolder(trash.id)).toBe(0);
    expect((await demo.listFolders("acc-private")).find((f) => f.role === "trash")!.total).toBe(0);
  });
});
