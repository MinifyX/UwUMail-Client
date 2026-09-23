import { describe, expect, it } from "vitest";
import {
  emptyRuleSet,
  isForwardAddress,
  newRule,
  parseRulesScript,
  rulesToSieve,
  validateRule,
  type MailRule,
  type RuleSet,
} from "./sieveRules";

function rule(patch: Partial<MailRule>): MailRule {
  return { ...newRule(), id: "r1", name: "Rule", actions: [{ type: "markRead" }], ...patch };
}

const set = (...rules: MailRule[]): RuleSet => ({ v: 1, rules });

/** The Sieve part of a script, without the two comment lines on top. */
function body(script: string): string {
  return script.split("\n").slice(2).join("\n");
}

describe("rulesToSieve", () => {
  it("writes the documented layout for a rule with every kind of action", () => {
    const script = rulesToSieve(
      set(
        rule({
          name: "Boss",
          conditions: [{ field: "from", op: "contains", value: "boss@example.com" }],
          actions: [
            { type: "move", mailboxId: "M12", mailboxName: "Work/Boss" },
            { type: "forward", address: "me@example.org", keepCopy: true },
            { type: "markRead" },
          ],
          stop: true,
        }),
      ),
    );
    const lines = script.split("\n");
    expect(lines[0]).toBe(
      "# Mail rules managed by UwUMail. Edit them in UwUMail; edits made elsewhere switch UwUMail to text mode.",
    );
    expect(lines[1]!.startsWith('# uwumail-rules: {"v":1,"rules":[')).toBe(true);
    expect(body(script)).toBe(
      [
        'require ["fileinto", "imap4flags", "mailboxid", "copy"];',
        "",
        "# Boss",
        'if allof (header :contains "from" "boss@example.com") {',
        '    addflag "\\\\Seen";',
        '    redirect :copy "me@example.org";',
        '    fileinto :mailboxid "M12" "Work/Boss";',
        "    stop;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("requires only the extensions that are used, and nothing for an empty set", () => {
    expect(body(rulesToSieve(emptyRuleSet()))).toBe("");
    expect(body(rulesToSieve(set(rule({ actions: [{ type: "flag" }] }))))).toMatch(/^require \["imap4flags"\];\n/);
    expect(
      body(rulesToSieve(set(rule({ actions: [{ type: "forward", address: "a@b.example", keepCopy: false }] })))),
    ).toMatch(/^\n# Rule\n/);
  });

  it("emits flags first, then the redirect, then the folder, whatever order they were added in", () => {
    const script = rulesToSieve(
      set(
        rule({
          conditions: [],
          actions: [
            { type: "trash", mailboxId: "T", mailboxName: "Trash" },
            { type: "flag" },
            { type: "forward", address: "x@y.example", keepCopy: false },
            { type: "markRead" },
          ],
        }),
      ),
    );
    expect(script).toContain(
      [
        "if true {",
        '    addflag "\\\\Seen";',
        '    addflag "\\\\Flagged";',
        '    redirect "x@y.example";',
        '    fileinto :mailboxid "T" "Trash";',
        "}",
      ].join("\n"),
    );
  });

  it("maps every field and operator to its test", () => {
    const script = rulesToSieve(
      set(
        rule({
          match: "any",
          conditions: [
            { field: "to", op: "is", value: "me@example.org" },
            { field: "toOrCc", op: "isNot", value: "team@example.org" },
            { field: "cc", op: "notContains", value: "noise" },
            { field: "subject", op: "is", value: "Hello" },
            { field: "listId", op: "startsWith", value: "dev" },
            { field: "subject", op: "endsWith", value: "!" },
          ],
        }),
      ),
    );
    expect(script).toContain(
      "if anyof (" +
        [
          'address :is :all "to" "me@example.org"',
          'not address :is :all ["to", "cc"] "team@example.org"',
          'not header :contains "cc" "noise"',
          'header :is "subject" "Hello"',
          'header :matches "list-id" "dev*"',
          'header :matches "subject" "*!"',
        ].join(", ") +
        ") {",
    );
  });

  it("escapes quotes and backslashes and strips line breaks from every string", () => {
    const script = rulesToSieve(
      set(
        rule({
          name: 'Evil\n} discard; # "name"',
          conditions: [{ field: "subject", op: "contains", value: 'say "hi" \\ bye\r\n' }],
          actions: [{ type: "move", mailboxId: 'M"1', mailboxName: "A\\B\nC" }],
        }),
      ),
    );
    expect(script).toContain('# Evil} discard; # "name"\n');
    expect(script).toContain('header :contains "subject" "say \\"hi\\" \\\\ bye"');
    expect(script).toContain('fileinto :mailboxid "M\\"1" "A\\\\BC";');
    // Nothing a name smuggled in became a command of its own.
    expect(script.split("\n").filter((line) => line.trimStart().startsWith("discard"))).toEqual([]);
  });

  it("treats wildcards in startsWith and endsWith as literal characters", () => {
    const script = rulesToSieve(
      set(
        rule({
          conditions: [
            { field: "subject", op: "startsWith", value: "50% *off?" },
            { field: "subject", op: "endsWith", value: "a\\b" },
          ],
        }),
      ),
    );
    // :matches sees 50% \*off\?* and *a\\b; the Sieve string doubles every backslash once more.
    expect(script).toContain('header :matches "subject" "50% \\\\*off\\\\?*"');
    expect(script).toContain('header :matches "subject" "*a\\\\\\\\b"');
  });

  /**
   * The bug this is here for: "Sender ends with @shop.example" became
   * `header :matches "from" "*@shop.example"`, which never matches `Shop <news@shop.example>`
   * because of the closing bracket. It only showed when a real server filtered delivered mail.
   */
  it("compares the bare address for starts and ends with on address fields", () => {
    const script = rulesToSieve(
      set(
        rule({
          conditions: [
            { field: "from", op: "endsWith", value: "@shop.example" },
            { field: "to", op: "startsWith", value: "team-" },
            { field: "cc", op: "endsWith", value: "*.example" },
            { field: "toOrCc", op: "startsWith", value: "me@" },
          ],
        }),
      ),
    );
    expect(script).toContain(
      "if allof (" +
        [
          'address :matches :all "from" "*@shop.example"',
          'address :matches :all "to" "team-*"',
          'address :matches :all "cc" "*\\\\*.example"',
          'address :matches :all ["to", "cc"] "me@*"',
        ].join(", ") +
        ") {",
    );
    expect(script).not.toContain('header :matches "from"');
  });

  it("leaves disabled rules out of the Sieve but keeps them in the data line", () => {
    const script = rulesToSieve(set(rule({ name: "Off", enabled: false, actions: [{ type: "flag" }] })));
    expect(body(script)).toBe("");
    expect(script).toContain('"name":"Off"');
  });
});

describe("parseRulesScript", () => {
  const sample = set(
    rule({
      id: "a",
      name: "Newsletters",
      match: "any",
      conditions: [
        { field: "listId", op: "contains", value: "news" },
        { field: "from", op: "endsWith", value: "@shop.example" },
      ],
      actions: [{ type: "move", mailboxId: "M3", mailboxName: "Reading/News" }, { type: "markRead" }],
      stop: true,
    }),
    rule({ id: "b", name: "Paused", enabled: false }),
    rule({
      id: "c",
      name: "Forward invoices",
      conditions: [{ field: "subject", op: "contains", value: 'Invoice "2026"' }],
      actions: [{ type: "forward", address: "books@example.org", keepCopy: true }],
    }),
  );

  it("reads back exactly what it wrote", () => {
    expect(parseRulesScript(rulesToSieve(sample))).toEqual({ kind: "rules", set: sample });
  });

  it("doesn't mind CRLF line endings or trailing whitespace", () => {
    const crlf = rulesToSieve(sample).replace(/\n/g, "  \r\n");
    expect(parseRulesScript(crlf)).toEqual({ kind: "rules", set: sample });
  });

  it("reads an empty rule set", () => {
    expect(parseRulesScript(rulesToSieve(emptyRuleSet()))).toEqual({ kind: "rules", set: emptyRuleSet() });
  });

  it("returns the cleaned rules when a name held a line break", () => {
    const parsed = parseRulesScript(rulesToSieve(set(rule({ name: "Two\nLines" }))));
    expect(parsed.kind === "rules" && parsed.set.rules[0]!.name).toBe("TwoLines");
  });

  it("calls a script edited by hand foreign", () => {
    const edited = rulesToSieve(sample).replace("stop;", "discard;");
    expect(parseRulesScript(edited)).toEqual({ kind: "foreign", text: edited });
  });

  it("calls a script without the data line foreign", () => {
    const text = 'require ["fileinto"];\nif header :contains "subject" "x" { fileinto "X"; }\n';
    expect(parseRulesScript(text)).toEqual({ kind: "foreign", text });
  });

  it("calls a data line that doesn't match the Sieve foreign", () => {
    const script = rulesToSieve(sample);
    const tampered = script.replace('"name":"Newsletters"', '"name":"Other"');
    expect(parseRulesScript(tampered).kind).toBe("foreign");
  });

  it("calls broken or unexpected JSON foreign instead of throwing", () => {
    const withData = (data: string) => `# uwumail-rules: ${data}\n`;
    expect(parseRulesScript(withData("{not json")).kind).toBe("foreign");
    expect(parseRulesScript(withData('{"v":2,"rules":[]}')).kind).toBe("foreign");
    expect(parseRulesScript(withData('{"v":1,"rules":[{"id":"x"}]}')).kind).toBe("foreign");
    expect(
      parseRulesScript(
        withData(
          '{"v":1,"rules":[{"id":"x","name":"n","enabled":true,"match":"all","conditions":[],"actions":[{"type":"discard"}],"stop":false}]}',
        ),
      ).kind,
    ).toBe("foreign");
  });
});

describe("validateRule", () => {
  it("accepts a complete rule", () => {
    expect(
      validateRule(
        rule({
          conditions: [{ field: "from", op: "contains", value: "x" }],
          actions: [{ type: "forward", address: "a@b.example", keepCopy: false }],
        }),
      ),
    ).toEqual([]);
  });

  it("names every problem", () => {
    const problems = validateRule(
      rule({
        name: " ",
        conditions: [{ field: "from", op: "contains", value: "" }],
        actions: [
          { type: "move", mailboxId: "", mailboxName: "" },
          { type: "trash", mailboxId: "T", mailboxName: "Trash" },
          { type: "forward", address: "not an address", keepCopy: false },
          { type: "forward", address: "a@b.example", keepCopy: false },
        ],
      }),
    );
    expect(problems).toEqual([
      { kind: "noName" },
      { kind: "emptyValue", condition: 0 },
      { kind: "noFolder", action: 0 },
      { kind: "badAddress", action: 2 },
      { kind: "tooManyForwards" },
      { kind: "tooManyFolders" },
    ]);
    expect(validateRule(rule({ actions: [] }))).toEqual([{ kind: "emptyValue", condition: 0 }, { kind: "noActions" }]);
  });
});

describe("isForwardAddress", () => {
  it("takes plain addresses only", () => {
    expect(isForwardAddress("me@example.org")).toBe(true);
    expect(isForwardAddress(" me@example.org ")).toBe(true);
    for (const bad of [
      "me",
      "me@example",
      "a b@example.org",
      'a"@example.org',
      "a@b.example, c@d.example",
      "<a@b.example>",
    ]) {
      expect(isForwardAddress(bad)).toBe(false);
    }
  });
});

describe("newRule", () => {
  it("hands out a fresh id every time", () => {
    expect(newRule().id).not.toBe(newRule().id);
  });
});
