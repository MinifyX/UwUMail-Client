import { describe, expect, it } from "vitest";
import type { Signature } from "@/backend/types";
import { sinceText } from "@/features/settings/SettingsSync";
import { MAX_VALUE_BYTES } from "@/lib/settingsSync";
import { cleanSyncedSignature, signatureTravels } from "./accountSync";

const signature = (html: string): Signature => ({
  id: "0f8a1c2e-5b7d-4e3f-9a61-2c4b8d0e7f13",
  email: "mini@uwumail.test",
  name: "Kurz",
  html,
  forNew: true,
  forReplies: false,
});

describe("signatures in the settings sync", () => {
  it("lets signatures with embedded pictures travel", () => {
    expect(signatureTravels(signature('<p>Mini</p><img src="data:image/png;base64,iVBORw0KGgo=">'))).toBe(true);
  });

  it("keeps back what the server can't take", () => {
    expect(signatureTravels(signature('<img src="cid:logo@uwumail.test">'))).toBe(false);
    const picture = `<img src="data:image/png;base64,${"A".repeat(MAX_VALUE_BYTES)}">`;
    expect(signatureTravels(signature(picture))).toBe(false);
  });

  it("cleans what comes from another device", () => {
    const html = cleanSyncedSignature(
      '<p onclick="steal()">Mini<script>alert(1)</script></p><img src="https://tracker.example/p.gif"><img src="data:image/png;base64,AA==">',
    );
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("script");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("data:image/png;base64,AA==");
  });
});

describe("the sync status line", () => {
  it("says how long ago in the app's language", () => {
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    expect(sinceText(now - 2 * 60_000, now, "de")).toBe("vor 2 Min.");
    expect(sinceText(now - 10_000, now, "en")).toBe("now");
    expect(sinceText(now - 3 * 3_600_000, now, "en")).toBe("3 hr. ago");
  });
});
