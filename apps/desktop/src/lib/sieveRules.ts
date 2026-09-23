/**
 * Mail rules as a Sieve script (RFC 5228), shared with the UwUMail app.
 *
 * The rules live on the server as one script named "UwUMail". Its second line carries the
 * rules as JSON, so the editor can read them back; the Sieve below it is generated from that
 * JSON. When the Sieve no longer matches what the JSON would generate, somebody edited the
 * script elsewhere (ManageSieve, another client), and the interface switches to showing the
 * text instead of guessing what the edit meant.
 *
 * Keep this file byte-identical with the app's copy, like settingsSync.ts.
 */

export interface MailRule {
  /** Random and stable, for lists and editing. */
  id: string;
  /** User-visible; newlines are stripped. */
  name: string;
  /** Disabled rules stay in the JSON but are not emitted as Sieve. */
  enabled: boolean;
  match: "all" | "any";
  /** Empty: the rule applies to every message. */
  conditions: RuleCondition[];
  /** At least one. */
  actions: RuleAction[];
  /** Don't apply further rules. */
  stop: boolean;
}

export type RuleField = "from" | "to" | "cc" | "toOrCc" | "subject" | "listId";
export type RuleOp = "contains" | "notContains" | "is" | "isNot" | "startsWith" | "endsWith";

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export type RuleAction =
  /** `mailboxName` is the full path, "/"-separated. */
  | { type: "move"; mailboxId: string; mailboxName: string }
  | { type: "markRead" }
  | { type: "flag" }
  | { type: "trash"; mailboxId: string; mailboxName: string }
  | { type: "forward"; address: string; keepCopy: boolean };

export interface RuleSet {
  v: 1;
  rules: MailRule[];
}

export type RuleProblem =
  | { kind: "noName" }
  | { kind: "noActions" }
  | { kind: "emptyValue"; condition: number }
  | { kind: "noFolder"; action: number }
  | { kind: "badAddress"; action: number }
  | { kind: "tooManyForwards" }
  | { kind: "tooManyFolders" };

export type ParsedRules = { kind: "rules"; set: RuleSet } | { kind: "foreign"; text: string };

export const RULE_FIELDS: readonly RuleField[] = ["from", "to", "cc", "toOrCc", "subject", "listId"];
export const RULE_OPS: readonly RuleOp[] = ["contains", "notContains", "is", "isNot", "startsWith", "endsWith"];

const HEADER =
  "# Mail rules managed by UwUMail. Edit them in UwUMail; edits made elsewhere switch UwUMail to text mode.";
const DATA_PREFIX = "# uwumail-rules: ";

const HEADER_NAMES: Record<RuleField, string> = {
  from: '"from"',
  to: '"to"',
  cc: '"cc"',
  toOrCc: '["to", "cc"]',
  subject: '"subject"',
  listId: '"list-id"',
};

/** Fields holding addresses, compared with `address :is :all` for "is". */
const ADDRESS_FIELDS = new Set<RuleField>(["from", "to", "cc", "toOrCc"]);

export function emptyRuleSet(): RuleSet {
  return { v: 1, rules: [] };
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newRule(): MailRule {
  return {
    id: randomId(),
    name: "",
    enabled: true,
    match: "all",
    conditions: [{ field: "from", op: "contains", value: "" }],
    actions: [],
    stop: false,
  };
}

/** Line breaks (and other control characters but tab) would end a comment or break a string. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, "");
}

/** A Sieve quoted string. */
function quote(text: string): string {
  return `"${clean(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wildcards in a value compared with `:matches` are meant literally. */
function literalPattern(text: string): string {
  return clean(text).replace(/[\\*?]/g, (char) => `\\${char}`);
}

/** Forward addresses: one plain mailbox, nothing a header or the Sieve string could misread. */
export function isForwardAddress(address: string): boolean {
  const trimmed = address.trim();
  return trimmed.length <= 254 && /^[^\s@"\\<>(),;:[\]]+@[^\s@"\\<>(),;:[\]]+\.[^\s@"\\<>(),;:[\]]+$/.test(trimmed);
}

export function validateRule(rule: MailRule): RuleProblem[] {
  const problems: RuleProblem[] = [];
  if (!clean(rule.name).trim()) problems.push({ kind: "noName" });
  rule.conditions.forEach((condition, index) => {
    if (!clean(condition.value).trim()) problems.push({ kind: "emptyValue", condition: index });
  });
  if (rule.actions.length === 0) problems.push({ kind: "noActions" });
  let forwards = 0;
  let folders = 0;
  rule.actions.forEach((action, index) => {
    if (action.type === "move" || action.type === "trash") {
      folders += 1;
      if (!action.mailboxId) problems.push({ kind: "noFolder", action: index });
    }
    if (action.type === "forward") {
      forwards += 1;
      if (!isForwardAddress(action.address)) problems.push({ kind: "badAddress", action: index });
    }
  });
  // The server sends at most one redirect per message, and one mail should land in one folder.
  if (forwards > 1) problems.push({ kind: "tooManyForwards" });
  if (folders > 1) problems.push({ kind: "tooManyFolders" });
  return problems;
}

function test(condition: RuleCondition): string {
  const header = HEADER_NAMES[condition.field];
  const value = condition.value.trim();
  let positive: string;
  switch (condition.op) {
    case "contains":
    case "notContains":
      positive = `header :contains ${header} ${quote(value)}`;
      break;
    case "is":
    case "isNot":
      positive = ADDRESS_FIELDS.has(condition.field)
        ? `address :is :all ${header} ${quote(value)}`
        : `header :is ${header} ${quote(value)}`;
      break;
    case "startsWith":
      positive = `header :matches ${header} ${quote(`${literalPattern(value)}*`)}`;
      break;
    case "endsWith":
      positive = `header :matches ${header} ${quote(`*${literalPattern(value)}`)}`;
      break;
  }
  return condition.op === "notContains" || condition.op === "isNot" ? `not ${positive}` : positive;
}

function ruleToSieve(rule: MailRule): string {
  const condition =
    rule.conditions.length === 0
      ? "true"
      : `${rule.match === "any" ? "anyof" : "allof"} (${rule.conditions.map(test).join(", ")})`;
  const lines: string[] = [];
  if (rule.actions.some((action) => action.type === "markRead")) lines.push('addflag "\\\\Seen";');
  if (rule.actions.some((action) => action.type === "flag")) lines.push('addflag "\\\\Flagged";');
  for (const action of rule.actions) {
    if (action.type === "forward") {
      lines.push(`redirect ${action.keepCopy ? ":copy " : ""}${quote(action.address.trim())};`);
    }
  }
  for (const action of rule.actions) {
    if (action.type === "move" || action.type === "trash") {
      lines.push(`fileinto :mailboxid ${quote(action.mailboxId)} ${quote(action.mailboxName)};`);
    }
  }
  if (rule.stop) lines.push("stop;");
  return [`# ${clean(rule.name)}`, `if ${condition} {`, ...lines.map((line) => `    ${line}`), "}"].join("\n");
}

/** The rule set as it is stored: every string cleaned, so the JSON and the Sieve agree. */
function normalize(set: RuleSet): RuleSet {
  return {
    v: 1,
    rules: set.rules.map((rule) => ({
      id: clean(rule.id),
      name: clean(rule.name),
      enabled: rule.enabled,
      match: rule.match,
      conditions: rule.conditions.map((condition) => ({
        field: condition.field,
        op: condition.op,
        value: clean(condition.value),
      })),
      actions: rule.actions.map((action): RuleAction => {
        switch (action.type) {
          case "move":
          case "trash":
            return { type: action.type, mailboxId: clean(action.mailboxId), mailboxName: clean(action.mailboxName) };
          case "forward":
            return { type: "forward", address: clean(action.address), keepCopy: action.keepCopy };
          default:
            return { type: action.type };
        }
      }),
      stop: rule.stop,
    })),
  };
}

export function rulesToSieve(input: RuleSet): string {
  const set = normalize(input);
  const active = set.rules.filter((rule) => rule.enabled);
  const actions = active.flatMap((rule) => rule.actions);
  const needs = {
    fileinto: actions.some((action) => action.type === "move" || action.type === "trash"),
    imap4flags: actions.some((action) => action.type === "markRead" || action.type === "flag"),
    copy: actions.some((action) => action.type === "forward" && action.keepCopy),
  };
  const require = [
    ...(needs.fileinto ? ["fileinto"] : []),
    ...(needs.imap4flags ? ["imap4flags"] : []),
    ...(needs.fileinto ? ["mailboxid"] : []),
    ...(needs.copy ? ["copy"] : []),
  ];
  const head = [HEADER, `${DATA_PREFIX}${JSON.stringify(set)}`];
  if (require.length > 0) head.push(`require [${require.map((name) => `"${name}"`).join(", ")}];`);
  return [head.join("\n"), ...active.map(ruleToSieve)].join("\n\n") + "\n";
}

/** Line endings and trailing whitespace don't count as an edit. */
function canonical(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readAction(value: unknown): RuleAction | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "move":
    case "trash":
      return typeof value.mailboxId === "string" && typeof value.mailboxName === "string"
        ? { type: value.type, mailboxId: value.mailboxId, mailboxName: value.mailboxName }
        : null;
    case "forward":
      return typeof value.address === "string" && typeof value.keepCopy === "boolean"
        ? { type: "forward", address: value.address, keepCopy: value.keepCopy }
        : null;
    case "markRead":
    case "flag":
      return { type: value.type };
    default:
      return null;
  }
}

function readCondition(value: unknown): RuleCondition | null {
  if (!isObject(value)) return null;
  const { field, op } = value;
  if (!RULE_FIELDS.includes(field as RuleField) || !RULE_OPS.includes(op as RuleOp)) return null;
  if (typeof value.value !== "string") return null;
  return { field: field as RuleField, op: op as RuleOp, value: value.value };
}

function readRule(value: unknown): MailRule | null {
  if (!isObject(value)) return null;
  const { id, name, enabled, match, stop, conditions, actions } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof enabled !== "boolean") return null;
  if ((match !== "all" && match !== "any") || typeof stop !== "boolean") return null;
  if (!Array.isArray(conditions) || !Array.isArray(actions)) return null;
  const readConditions = conditions.map(readCondition);
  const readActions = actions.map(readAction);
  if (readConditions.includes(null) || readActions.includes(null)) return null;
  return {
    id,
    name,
    enabled,
    match,
    conditions: readConditions as RuleCondition[],
    actions: readActions as RuleAction[],
    stop,
  };
}

/** Reads the rules back, or says the script was written or changed by something else. */
export function parseRulesScript(text: string): ParsedRules {
  const foreign = { kind: "foreign" as const, text };
  const line = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .find((candidate) => candidate.startsWith(DATA_PREFIX));
  if (!line) return foreign;
  let data: unknown;
  try {
    data = JSON.parse(line.slice(DATA_PREFIX.length));
  } catch {
    return foreign;
  }
  if (!isObject(data) || data.v !== 1 || !Array.isArray(data.rules)) return foreign;
  const rules = data.rules.map(readRule);
  if (rules.includes(null)) return foreign;
  const set: RuleSet = { v: 1, rules: rules as MailRule[] };
  if (canonical(rulesToSieve(set)) !== canonical(text)) return foreign;
  return { kind: "rules", set: normalize(set) };
}
