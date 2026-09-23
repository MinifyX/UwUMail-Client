import { describe, expect, it } from "vitest";
import { DemoBackend } from "./demo";

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
