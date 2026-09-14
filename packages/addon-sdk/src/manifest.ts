/**
 * The addon manifest (`uwuaddon.json`). See docs/addons.md for the full
 * specification.
 */

export const MANIFEST_VERSION = 1;

export type Localized = string | ({ en: string } & Record<string, string>);

export const PERMISSIONS = [
  "accounts.read",
  "folders.read",
  "messages.read",
  "messages.modify",
  "messages.send",
  "compose.write",
  "contacts.read",
  "notifications",
  "schedule",
  "clipboard.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionRisk = "low" | "medium" | "high";

export const PERMISSION_RISK: Record<Permission, PermissionRisk> = {
  "accounts.read": "low",
  "folders.read": "low",
  "messages.read": "high",
  "messages.modify": "high",
  "messages.send": "high",
  "compose.write": "medium",
  "contacts.read": "medium",
  notifications: "low",
  schedule: "low",
  "clipboard.write": "low",
};

export interface CommandContribution {
  id: string;
  title: Localized;
  shortcut?: string;
}

export interface ActionContribution {
  command: string;
  /** A Lucide icon name, e.g. "sparkles". */
  icon: string;
}

export interface PanelContribution {
  id: string;
  title: Localized;
  icon: string;
  entry: string;
}

export interface AddonManifest {
  $schema?: string;
  manifestVersion: typeof MANIFEST_VERSION;
  id: string;
  version: string;
  name: Localized;
  description: Localized;
  author: { name: string; url?: string; email?: string };
  license?: string;
  icon?: string;
  engines: { uwumail: string };
  permissions: Permission[];
  hosts?: string[];
  background?: string;
  contributes?: {
    commands?: CommandContribution[];
    messageActions?: ActionContribution[];
    composeActions?: ActionContribution[];
    panels?: PanelContribution[];
    settings?: { entry: string };
  };
}

export interface ManifestIssue {
  path: string;
  message: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_PATTERN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/;
const ENTRY_PATTERN = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkLocalized(value: unknown, path: string, issues: ManifestIssue[]) {
  if (typeof value === "string" && value.trim()) return;
  if (isObject(value) && typeof value.en === "string" && Object.values(value).every((v) => typeof v === "string"))
    return;
  issues.push({ path, message: "must be a non-empty string or a map of locales with an `en` entry" });
}

function checkEntry(value: unknown, path: string, issues: ManifestIssue[]) {
  if (typeof value !== "string" || !ENTRY_PATTERN.test(value)) {
    issues.push({ path, message: "must be a relative path inside the addon" });
  }
}

/** Validates an untrusted manifest. Returns every problem instead of stopping at the first. */
export function validateManifest(
  input: unknown,
): { ok: true; manifest: AddonManifest } | { ok: false; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  if (!isObject(input)) return { ok: false, issues: [{ path: "", message: "manifest must be a JSON object" }] };

  if (input.manifestVersion !== MANIFEST_VERSION) {
    issues.push({ path: "manifestVersion", message: `must be ${MANIFEST_VERSION}` });
  }
  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    issues.push({ path: "id", message: "must be reverse-DNS, lowercase, e.g. dev.example.my-addon" });
  }
  if (typeof input.version !== "string" || !SEMVER_PATTERN.test(input.version)) {
    issues.push({ path: "version", message: "must be a SemVer version like 1.0.0" });
  }
  checkLocalized(input.name, "name", issues);
  checkLocalized(input.description, "description", issues);
  if (!isObject(input.author) || typeof input.author.name !== "string") {
    issues.push({ path: "author.name", message: "is required" });
  }
  if (!isObject(input.engines) || typeof input.engines.uwumail !== "string") {
    issues.push({ path: "engines.uwumail", message: "must be a SemVer range" });
  }

  if (!Array.isArray(input.permissions)) {
    issues.push({ path: "permissions", message: "must be an array (use [] for none)" });
  } else {
    input.permissions.forEach((permission, index) => {
      if (!PERMISSIONS.includes(permission as Permission)) {
        issues.push({ path: `permissions[${index}]`, message: `unknown permission "${String(permission)}"` });
      }
    });
  }

  if (input.hosts !== undefined) {
    if (!Array.isArray(input.hosts)) issues.push({ path: "hosts", message: "must be an array of HTTPS origins" });
    else
      input.hosts.forEach((host, index) => {
        if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
          issues.push({ path: `hosts[${index}]`, message: "must be an HTTPS origin like https://api.example.com" });
        }
      });
  }

  if (input.background !== undefined) checkEntry(input.background, "background", issues);
  if (input.icon !== undefined) checkEntry(input.icon, "icon", issues);

  const contributes = input.contributes;
  if (contributes !== undefined) {
    if (!isObject(contributes)) {
      issues.push({ path: "contributes", message: "must be an object" });
    } else {
      const commandIds = new Set<string>();
      if (Array.isArray(contributes.commands)) {
        contributes.commands.forEach((command, index) => {
          const path = `contributes.commands[${index}]`;
          if (!isObject(command) || typeof command.id !== "string") {
            issues.push({ path, message: "needs an id" });
            return;
          }
          commandIds.add(command.id);
          checkLocalized(command.title, `${path}.title`, issues);
        });
      }
      for (const key of ["messageActions", "composeActions"] as const) {
        const actions = contributes[key];
        if (!Array.isArray(actions)) continue;
        actions.forEach((action, index) => {
          if (!isObject(action) || typeof action.command !== "string" || !commandIds.has(action.command)) {
            issues.push({ path: `contributes.${key}[${index}].command`, message: "must reference a declared command" });
          }
        });
      }
      if (Array.isArray(contributes.panels)) {
        contributes.panels.forEach((panel, index) => {
          const path = `contributes.panels[${index}]`;
          if (!isObject(panel) || typeof panel.id !== "string") issues.push({ path, message: "needs an id" });
          else {
            checkLocalized(panel.title, `${path}.title`, issues);
            checkEntry(panel.entry, `${path}.entry`, issues);
          }
        });
      }
      if (isObject(contributes.settings)) checkEntry(contributes.settings.entry, "contributes.settings.entry", issues);
    }
  }

  return issues.length === 0 ? { ok: true, manifest: input as unknown as AddonManifest } : { ok: false, issues };
}

export function localize(value: Localized, locale: string): string {
  if (typeof value === "string") return value;
  return value[locale] ?? value[locale.split("-")[0] ?? ""] ?? value.en;
}
