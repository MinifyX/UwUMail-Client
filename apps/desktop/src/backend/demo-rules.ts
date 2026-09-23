// A mail rules script for the demo's UwUMail server account, written in the layout of
// lib/sieveRules.ts (see the shared calendar/rules contract): a JSON copy of the rules in a
// comment, then the Sieve they stand for.

type Lang = "de" | "en";

export function demoRulesScript(lang: Lang): string {
  const de = lang === "de";
  const receipts = de ? "Rechnungen" : "Receipts";
  const bugs = de ? "Projekte/UwUMail/Bugs" : "Projects/UwUMail/Bugs";
  const rules = [
    {
      id: "r-receipts",
      name: de ? "Rechnungen vom Shop" : "Receipts from the shop",
      enabled: true,
      match: "all",
      conditions: [{ field: "from", op: "is", value: "orders@pixelparts.example" }],
      actions: [{ type: "markRead" }, { type: "move", mailboxId: "acc-private:receipts", mailboxName: receipts }],
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
      actions: [{ type: "flag" }, { type: "move", mailboxId: "acc-private:projects-uwumail-bugs", mailboxName: bugs }],
      stop: false,
    },
  ];
  return [
    "# Mail rules managed by UwUMail. Edit them in UwUMail; edits made elsewhere switch UwUMail to text mode.",
    `# uwumail-rules: ${JSON.stringify({ v: 1, rules })}`,
    'require ["fileinto", "imap4flags", "mailboxid"];',
    "",
    `# ${rules[0]!.name}`,
    'if allof (address :is :all "from" "orders@pixelparts.example") {',
    '    addflag "\\\\Seen";',
    `    fileinto :mailboxid "acc-private:receipts" "${receipts}";`,
    "    stop;",
    "}",
    "",
    `# ${rules[1]!.name}`,
    'if anyof (header :matches "subject" "[Bug]*", header :contains "list-id" "bugs.uwumail.dev") {',
    '    addflag "\\\\Flagged";',
    `    fileinto :mailboxid "acc-private:projects-uwumail-bugs" "${bugs}";`,
    "}",
    "",
  ].join("\n");
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
