import { describe, expect, it } from "vitest";
import type { Folder } from "@/backend/types";
import { inWorkspace, unreadInboxes, workspaceOf } from "./workspaces";

const mailboxes = [{ id: "home" }, { id: "studio" }, { id: "club" }, { id: "shop" }];
const business = ["studio", "shop"];

function inbox(accountId: string, unread: number, role: Folder["role"] = "inbox"): Folder {
  return {
    id: `${accountId}-${role}`,
    accountId,
    name: "Inbox",
    path: "INBOX",
    role,
    parentId: null,
    selectable: true,
    unread,
    total: unread,
  };
}

describe("workspaces", () => {
  it("counts every mailbox that isn't business as private, new ones too", () => {
    expect(workspaceOf("studio", business)).toBe("business");
    expect(workspaceOf("home", business)).toBe("private");
    expect(workspaceOf("added-later", business)).toBe("private");
  });

  it("lists a workspace's mailboxes in their order", () => {
    expect(inWorkspace(mailboxes, "private", business).map((m) => m.id)).toEqual(["home", "club"]);
    expect(inWorkspace(mailboxes, "business", business).map((m) => m.id)).toEqual(["studio", "shop"]);
    expect(inWorkspace(mailboxes, "business", []).map((m) => m.id)).toEqual([]);
  });

  it("adds up unread inbox mail per workspace, other folders don't count", () => {
    const folders = [inbox("home", 3), inbox("club", 1), inbox("studio", 2), inbox("studio", 9, "junk")];
    expect(unreadInboxes(folders, business)).toEqual({ private: 4, business: 2 });
  });
});
