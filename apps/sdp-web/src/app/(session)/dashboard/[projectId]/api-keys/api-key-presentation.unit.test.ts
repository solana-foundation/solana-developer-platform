import type { Action } from "@sdp/types/actions";
import { API_KEY_STATUSES } from "@sdp/types/api-keys";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey } from "@/i18n/messages";
import { type TranslationValues, translate } from "@/i18n/translate";
import { testApiKey } from "@/test/api-keys";
import {
  type ApiKeyLifetime,
  type ApiKeyReach,
  type ApiKeyStatusFilter,
  apiKeyLifetime,
  apiKeyReach,
  apiKeyStatusFilter,
  formatLastUsed,
} from "./api-key-presentation";

const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function t(key: MessageKey, values?: TranslationValues): string {
  return translate(getMessages("en"), key, values);
}

describe("apiKeyLifetime", () => {
  it.each<[string, string | null, string | null, ApiKeyLifetime]>([
    ["never expires", null, null, { kind: "never" }],
    ["expires in 30 days", at(30 * DAY_MS), null, { kind: "until", at: at(30 * DAY_MS) }],
    ["expires in exactly 7 days", at(7 * DAY_MS), null, { kind: "soon", at: at(7 * DAY_MS) }],
    [
      "was rotated, its deadline before its expiry",
      at(30 * DAY_MS),
      at(HOUR_MS),
      { kind: "stopping", at: at(HOUR_MS) },
    ],
    ["was rotated and never expires", null, at(HOUR_MS), { kind: "stopping", at: at(HOUR_MS) }],
    [
      "was rotated, its expiry before its deadline",
      at(DAY_MS),
      at(30 * DAY_MS),
      { kind: "soon", at: at(DAY_MS) },
    ],
    [
      "is past its rotation deadline",
      at(30 * DAY_MS),
      at(-HOUR_MS),
      { kind: "ended", at: at(-HOUR_MS) },
    ],
    ["is past its expiry", at(-DAY_MS), null, { kind: "ended", at: at(-DAY_MS) }],
    ["expires this instant", at(0), null, { kind: "ended", at: at(0) }],
  ])("reads an active key that %s", (_case, expiresAt, rotationDeadline, lifetime) => {
    expect(
      apiKeyLifetime(testApiKey({ status: "active", expiresAt, rotationDeadline }), NOW)
    ).toEqual(lifetime);
  });

  it.each(API_KEY_STATUSES.filter((status) => status !== "active"))(
    "ends a %s key whatever its dates say",
    (status) => {
      expect(
        apiKeyLifetime(
          testApiKey({ status, expiresAt: at(30 * DAY_MS), rotationDeadline: at(HOUR_MS) }),
          NOW
        )
      ).toEqual({ kind: "ended", at: at(30 * DAY_MS) });
    }
  );
});

describe("apiKeyStatusFilter", () => {
  it.each<[ApiKeyLifetime, ApiKeyStatusFilter]>([
    [{ kind: "never" }, "active"],
    [{ kind: "until", at: at(30 * DAY_MS) }, "active"],
    [{ kind: "soon", at: at(DAY_MS) }, "active"],
    [{ kind: "stopping", at: at(HOUR_MS) }, "replaced"],
    [{ kind: "ended", at: null }, "expired"],
  ])("files a %o key under %s", (lifetime, filter) => {
    expect(apiKeyStatusFilter(lifetime)).toBe(filter);
  });
});

describe("formatLastUsed", () => {
  it.each<[string | null, string]>([
    [null, "Never used"],
    [at(-30 * 1000), "1 min ago"],
    [at(-40 * 60 * 1000), "40 min ago"],
    [at(-2.5 * HOUR_MS), "2 h ago"],
    [at(-3 * DAY_MS), "Nov 3, 2026"],
  ])("shows a key last used at %s as %s", (lastUsedAt, label) => {
    expect(formatLastUsed(lastUsedAt, NOW, "en", "UTC", t)).toBe(label);
  });
});

describe("apiKeyReach", () => {
  it.each<[Action[], ApiKeyReach]>([
    [["transfers.read", "wallets.read"], "read"],
    [["transfers.read", "recurring.manage"], "write"],
    [["issuance.enforce"], "write"],
    [["recurring.manage", "transfers.execute"], "funds"],
  ])("ranks %o as %s", (grants, reach) => {
    expect(apiKeyReach(grants)).toBe(reach);
  });
});
