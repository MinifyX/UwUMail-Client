// A mail rules script for the demo's UwUMail server account, made by lib/sieveRules.ts like the
// app makes it, so the rules page opens it as rules and not as text edited elsewhere.

import { rulesToSieve, type MailRule } from "@/lib/sieveRules";

type Lang = "de" | "en";

export function demoRulesScript(lang: Lang): string {
  const de = lang === "de";
  const rules: MailRule[] = [
    {
      id: "r-receipts",
      name: de ? "Rechnungen vom Shop" : "Receipts from the shop",
      enabled: true,
      match: "all",
      conditions: [{ field: "from", op: "is", value: "orders@pixelparts.example" }],
      actions: [
        { type: "markRead" },
        { type: "move", mailboxId: "acc-private:receipts", mailboxName: de ? "Rechnungen" : "Receipts" },
      ],
      stop: true,
    },
    {
      id: "r-bugs",
      name: de ? "Fehlerberichte" : "Bug reports",
      enabled: true,
      match: "any",
      conditions: [
        { field: "subject", op: "startsWith", value: "[Bug]" },
        { field: "listId", op: "contains", value: "bugs.uwumail.dev" },
      ],
      actions: [
        { type: "flag" },
        {
          type: "move",
          mailboxId: "acc-private:projects-uwumail-bugs",
          mailboxName: de ? "Projekte/UwUMail/Bugs" : "Projects/UwUMail/Bugs",
        },
      ],
      stop: false,
    },
  ];
  return rulesToSieve({ v: 1, rules });
}

/** Rough stand-in for the server's check: what the UwUMail server doesn't run, and broken blocks. */
export function demoValidateSieve(script: string): string | null {
  const code = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const unsupported of ["reject", "ereject", "vacation", "notify", "include"]) {
    if (new RegExp(`\\b${unsupported}\\b`).test(code)) return `"${unsupported}" isn't supported by this server.`;
  }
  let depth = 0;
  for (const [index, line] of code.split("\n").entries()) {
    for (const char of line) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth < 0) return `line ${index + 1}: unexpected "}"`;
    }
  }
  return depth === 0 ? null : 'missing "}" at the end of the script';
}
