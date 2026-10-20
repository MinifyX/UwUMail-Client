import { describe, expect, it } from "vitest";
import type { Folder, MailboxView } from "@/backend/types";
import { folderRefOf, moveInOrder, orderAccounts, resolveRefs, scopeFor, withRef } from "./arrangement";

const home = { id: "a1", email: "Mini@Home.test", protocol: "imap" as const };
const work = { id: "a2", email: "mini@work.test", protocol: "imap" as const };
const club = { id: "a3", email: "mini@club.test", protocol: "imap" as const };

function folder(id: string, accountId: string, path: string, role: Folder["role"] = null): Folder {
  return { id, accountId, path, name: path, role, unread: 1, total: 1, selectable: true } as Folder;
}

const folders = [folder("f1", "a1", "INBOX", "inbox"), folder("f2", "a1", "Projekte"), folder("f3", "a2", "Kunden")];

describe("mailbox order", () => {
  it("puts the named mailboxes first and keeps the others in their order", () => {
    expect(orderAccounts([home, work, club], ["mini@club.test", "mini@home.test"]).map((a) => a.id)).toEqual([
      "a3",
      "a1",
      "a2",
    ]);
    expect(orderAccounts([home, work], []).map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("moves a mailbox and keeps addresses of other devices behind", () => {
    expect(moveInOrder(["a", "b", "c"], 2, 0, ["gone", "b"])).toEqual(["c", "a", "b", "gone"]);
    expect(moveInOrder(["a", "b"], 0, 5, [])).toEqual(["a", "b"]);
  });
});

describe("folder refs", () => {
  it("adds and takes out refs without doubles", () => {
    const ref = { account: "mini@home.test", folder: "Projekte" };
    expect(withRef(withRef([], ref, true), ref, true)).toEqual([ref]);
    expect(withRef([ref], ref, false)).toEqual([]);
  });

  it("finds the folders here by address and path", () => {
    const refs = [
      { account: "mini@work.test", folder: "Kunden" },
      { account: "mini@home.test", folder: "Projekte" },
      { account: "else@other.test", folder: "INBOX" },
    ];
    expect(resolveRefs(refs, [home, work], folders).map((f) => f.id)).toEqual(["f3", "f2"]);
  });

  it("names JMAP folders by their names, not by the mailbox id", () => {
    const jmap = { id: "j1", email: "mini@jmap.test", protocol: "jmap" as const };
    const parent = { ...folder("m1", "j1", "Mb1"), name: "Projekte" };
    const child = { ...folder("m2", "j1", "Mb2"), name: "Bugs", parentId: "m1" };
    const all = [...folders, parent, child];
    expect(folderRefOf(child, jmap, all)).toEqual({ account: "mini@jmap.test", folder: "Projekte/Bugs" });
    expect(resolveRefs([{ account: "mini@jmap.test", folder: "Projekte/Bugs" }], [jmap], all)).toEqual([child]);
    expect(folderRefOf(folders[1]!, home, all)).toEqual({ account: "mini@home.test", folder: "Projekte" });
  });
});

describe("list scope", () => {
  const inbox: MailboxView = { kind: "unified", role: "inbox" };
  const flagged: MailboxView = { kind: "unified", role: "flagged" };
  const base = {
    accounts: [home, work, club],
    visible: [home, work, club],
    filtered: false,
    folders,
    hidden: [] as string[],
    extra: [{ account: "mini@home.test", folder: "Projekte" }],
  };

  it("needs no mailbox list while everything shows", () => {
    expect(scopeFor(inbox, base)).toEqual({ accountIds: undefined, includeFolderIds: ["f2"] });
    expect(scopeFor(flagged, base)).toEqual({ accountIds: undefined, includeFolderIds: undefined });
  });

  it("leaves hidden mailboxes out of the unified views only", () => {
    const hidden = { ...base, hidden: ["mini@work.test"] };
    expect(scopeFor(flagged, hidden).accountIds).toEqual(["a1", "a3"]);
    const folderView: MailboxView = { kind: "folder", accountId: "a2", folderId: "f3" };
    expect(scopeFor(folderView, hidden).accountIds).toBeUndefined();
  });

  it("keeps to the workspace", () => {
    const workspace = { ...base, visible: [home], filtered: true, hidden: ["mini@work.test"] };
    expect(scopeFor(inbox, workspace).accountIds).toEqual(["a1"]);
  });
});
