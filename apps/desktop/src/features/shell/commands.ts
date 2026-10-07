import { type IconProps, ICONS } from "@uwusuite/design";
import { backend } from "@/backend/backend";
import { playNyu } from "@/components/nyu/cameo";
import { i18n } from "@/i18n";
import { leaveThread, queryKeys, trashMail } from "@/lib/queries";
import { WORKSPACES } from "@/lib/workspaces";
import { layoutChoice, useSettings } from "@/state/settings";
import { announceMove, runLastUndo } from "@/state/undo";
import { useUi } from "@/state/ui";
import type { QueryClient } from "@tanstack/react-query";
import type { ThreadDetail } from "@/backend/types";
import { startNewContact } from "../contacts/state";
import { requestMove } from "../mail/selection";
import { SEARCH_INPUT_ID } from "../mail/ThreadList";
import { switchWorkspace, WORKSPACE_ICONS, WORKSPACE_KEYS, workspaceName } from "../workspaces/workspaces";

export interface Command {
  id: string;
  title: string;
  icon: IconProps["icon"];
  keys?: string[];
  run: () => void | Promise<void>;
  /** Only offered while a thread is open. */
  needsThread?: boolean;
}

function currentThread(client: QueryClient): ThreadDetail | undefined {
  const { selectedThreadId } = useUi.getState();
  if (!selectedThreadId) return undefined;
  const { conversations } = useSettings.getState();
  return client.getQueryData<ThreadDetail>([...queryKeys.thread, selectedThreadId, conversations]);
}

async function afterChange(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.threads }),
    client.invalidateQueries({ queryKey: queryKeys.thread }),
    client.invalidateQueries({ queryKey: queryKeys.folders }),
  ]);
}

/** App commands shared by the shortcuts and the command palette. */
export function buildCommands(
  client: QueryClient,
  t: (key: string, options?: Record<string, unknown>) => string,
  { calendar = false, contacts = false }: { calendar?: boolean; contacts?: boolean } = {},
): Command[] {
  const ui = useUi.getState();
  const settings = useSettings.getState();

  const withThread = (fn: (thread: ThreadDetail) => void | Promise<void>) => () => {
    const thread = currentThread(client);
    if (thread) return fn(thread);
  };
  const latest = (thread: ThreadDetail) => thread.messages[thread.messages.length - 1]!;
  const ids = (thread: ThreadDetail) => thread.messages.map((m) => m.id);

  return [
    {
      id: "compose",
      title: t("shortcuts.compose"),
      icon: ICONS.compose,
      keys: ["c"],
      run: () => ui.openCompose({ mode: "new" }),
    },
    {
      id: "search",
      title: t("shortcuts.search"),
      icon: ICONS.search,
      keys: ["/"],
      run: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    },
    {
      id: "reply",
      title: t("shortcuts.reply"),
      icon: ICONS.reply,
      keys: ["r"],
      needsThread: true,
      run: withThread((thread) => ui.openCompose({ mode: "reply", source: latest(thread) })),
    },
    {
      id: "replyAll",
      title: t("shortcuts.replyAll"),
      icon: ICONS.replyAll,
      keys: ["a"],
      needsThread: true,
      run: withThread((thread) => ui.openCompose({ mode: "replyAll", source: latest(thread) })),
    },
    {
      id: "forward",
      title: t("shortcuts.forward"),
      icon: ICONS.forward,
      keys: ["f"],
      needsThread: true,
      run: withThread((thread) => ui.openCompose({ mode: "forward", source: latest(thread) })),
    },
    {
      id: "archive",
      title: t("shortcuts.archive"),
      icon: ICONS.archive,
      keys: ["e"],
      needsThread: true,
      run: withThread(async (thread) => {
        leaveThread(thread.thread.id);
        announceMove(await backend().archive(ids(thread)), t("toast.archived"), () => afterChange(client));
        playNyu("archived");
        await afterChange(client);
      }),
    },
    {
      id: "trash",
      title: t("shortcuts.trash"),
      icon: ICONS.delete,
      keys: ["#", "Delete"],
      needsThread: true,
      // In the trash this deletes for good, after Nyu asked.
      run: withThread(async (thread) => {
        await trashMail(client, thread.messages, () => leaveThread(thread.thread.id));
      }),
    },
    {
      id: "move",
      title: t("shortcuts.move"),
      icon: ICONS.move,
      keys: ["v"],
      needsThread: true,
      run: withThread((thread) => requestMove(thread.messages, () => ui.selectThread(null))),
    },
    {
      id: "label",
      title: t("shortcuts.label"),
      icon: ICONS.label,
      keys: ["l"],
      needsThread: true,
      // The ticked conversations, else the open one.
      run: () => {
        const { checkedThreadIds, selectedThreadId, openLabeling } = useUi.getState();
        const threadIds = checkedThreadIds.length > 0 ? checkedThreadIds : selectedThreadId ? [selectedThreadId] : [];
        openLabeling({ threadIds });
      },
    },
    {
      id: "spam",
      title: t("shortcuts.spam"),
      icon: ICONS.spam,
      keys: ["!"],
      needsThread: true,
      run: withThread(async (thread) => {
        leaveThread(thread.thread.id);
        announceMove(await backend().markSpam(ids(thread), true), t("toast.markedSpam"), () => afterChange(client));
        await afterChange(client);
      }),
    },
    {
      id: "select",
      title: t("shortcuts.select"),
      icon: ICONS.select,
      keys: ["x"],
      needsThread: true,
      run: () => {
        const { selectedThreadId, checkedThreadIds, setCheckedThreadIds } = useUi.getState();
        if (!selectedThreadId) return;
        setCheckedThreadIds(
          checkedThreadIds.includes(selectedThreadId)
            ? checkedThreadIds.filter((id) => id !== selectedThreadId)
            : [...checkedThreadIds, selectedThreadId],
        );
      },
    },
    {
      id: "selectAll",
      title: t("shortcuts.selectAll"),
      icon: ICONS.selectAll,
      // The shell only takes Ctrl+A where no text is meant; see MailShell.
      keys: ["mod+a"],
      run: () => useUi.getState().checkAllVisible(),
    },
    {
      id: "undo",
      title: t("shortcuts.undo"),
      icon: ICONS.undo,
      keys: ["z"],
      run: () => {
        runLastUndo();
      },
    },
    {
      id: "flag",
      title: t("shortcuts.flag"),
      icon: ICONS.favorite,
      keys: ["s"],
      needsThread: true,
      run: withThread(async (thread) => {
        await backend().setFlags(ids(thread), { flagged: !thread.thread.flagged });
        await afterChange(client);
      }),
    },
    {
      id: "unread",
      title: t("shortcuts.unread"),
      icon: ICONS.unread,
      keys: ["u"],
      needsThread: true,
      run: withThread(async (thread) => {
        await backend().setFlags([latest(thread).id], { seen: false });
        ui.selectThread(null);
        await afterChange(client);
      }),
    },
    {
      id: "inbox",
      // With workspaces on, the inbox only holds the open workspace's mail.
      title: settings.workspaces ? t("shortcuts.goInbox") : t("nav.unified"),
      icon: settings.workspaces ? ICONS.inbox : ICONS.allMailboxes,
      keys: ["g i"],
      run: () => ui.setView({ kind: "unified", role: "inbox" }),
    },
    {
      id: "goSent",
      title: t("shortcuts.goSent"),
      icon: ICONS.send,
      keys: ["g s"],
      run: () => ui.setView({ kind: "unified", role: "sent" }),
    },
    {
      id: "goDrafts",
      title: t("shortcuts.goDrafts"),
      icon: ICONS.drafts,
      keys: ["g d"],
      run: () => ui.setView({ kind: "unified", role: "drafts" }),
    },
    {
      id: "goFlagged",
      title: t("shortcuts.goFlagged"),
      icon: ICONS.favorite,
      keys: ["g f"],
      run: () => ui.setView({ kind: "unified", role: "flagged" }),
    },
    ...(calendar
      ? [
          {
            id: "goCalendar",
            title: t("shortcuts.goCalendar"),
            icon: ICONS.calendar,
            keys: ["g c"],
            run: () => ui.setSection("calendar"),
          },
          {
            id: "newEvent",
            title: t("calendar.newEvent"),
            icon: ICONS.addEvent,
            run: async () => {
              ui.setSection("calendar");
              // The calendar loads on first use.
              const { startNewEvent } = await import("../calendar/CalendarSidebar");
              startNewEvent();
            },
          },
        ]
      : []),
    ...(settings.workspaces
      ? WORKSPACES.map((workspace): Command => ({
          id: `workspace-${workspace}`,
          title: t("workspace.switchTo", { name: workspaceName(workspace, settings.workspaceNames, t) }),
          icon: WORKSPACE_ICONS[workspace],
          keys: [WORKSPACE_KEYS[workspace]],
          run: () => switchWorkspace(workspace),
        }))
      : []),
    ...(contacts
      ? [
          {
            id: "goContacts",
            title: t("shortcuts.goContacts"),
            icon: ICONS.contacts,
            // "g p" is the private workspace here.
            keys: ["g k"],
            run: () => ui.setSection("contacts"),
          },
          {
            id: "newContact",
            title: t("contacts.newContact"),
            icon: ICONS.addContact,
            run: () => {
              ui.setSection("contacts");
              startNewContact();
            },
          },
        ]
      : []),
    // A phone has no Simple or Pro.
    ...(layoutChoice
      ? [
          {
            id: "layout",
            title: `${t("settings.layout")}: ${i18n.t(`layout.${settings.layout === "pro" ? "simple" : "pro"}.name`)}`,
            icon: ICONS.layout,
            run: () => settings.update({ layout: settings.layout === "pro" ? "simple" : "pro" }),
          },
        ]
      : []),
    {
      id: "tone",
      title: `${t("settings.tone")}: ${i18n.t(`tone.${settings.tone === "playful" ? "neutral" : "playful"}.name`)}`,
      icon: ICONS.nyu,
      run: () => settings.update({ tone: settings.tone === "playful" ? "neutral" : "playful" }),
    },
    {
      id: "theme",
      title: `${t("settings.theme")}: ${i18n.t(document.documentElement.dataset.theme === "dark" ? "theme.light" : "theme.dark")}`,
      icon: document.documentElement.dataset.theme === "dark" ? ICONS.lightTheme : ICONS.darkTheme,
      run: () => settings.update({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" }),
    },
    { id: "settings", title: t("nav.settings"), icon: ICONS.settings, keys: ["mod+,"], run: () => ui.openSettings() },
    {
      id: "shortcuts",
      title: t("settings.shortcuts"),
      icon: ICONS.keyboard,
      keys: ["?"],
      run: () => ui.setShortcutsOpen(true),
    },
  ];
}
