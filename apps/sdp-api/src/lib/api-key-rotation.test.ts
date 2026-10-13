import { describe, expect, it } from "vitest";
import { apiKeyRowRefusal } from "./api-key-rotation";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const LIVE = { status: "active", expires_at: null, rotation_deadline: null } as const;

describe("apiKeyRowRefusal", () => {
  it.each([
    ["an active key", LIVE, null],
    ["a revoked key", { ...LIVE, status: "revoked" }, "revoked"],
    ["a deactivated key", { ...LIVE, status: "deactivated" }, "revoked"],
    ["an expired status", { ...LIVE, status: "expired" }, "expired"],
    ["a past expiry", { ...LIVE, expires_at: "2026-10-09T11:59:59.000Z" }, "expired"],
    ["a future expiry", { ...LIVE, expires_at: "2026-10-10T00:00:00.000Z" }, null],
    ["a malformed expiry", { ...LIVE, expires_at: "not-a-date" }, "expired"],
    [
      "a passed rotation deadline",
      { ...LIVE, rotation_deadline: "2026-10-09T11:00:00.000Z" },
      "expired",
    ],
    ["a rotation grace period", { ...LIVE, rotation_deadline: "2026-10-09T13:00:00.000Z" }, null],
  ] as const)("judges %s", (_label, row, refusal) => {
    expect(apiKeyRowRefusal(row, NOW)).toBe(refusal);
  });
});
