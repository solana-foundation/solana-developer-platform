import { describe, expect, it } from "vitest";
import { decodeKeysetCursor, encodeKeysetCursor } from "./keyset-cursor";

describe("keyset cursor", () => {
  it("round-trips an ordered value and id as URL-safe base64", () => {
    const cursor = encodeKeysetCursor(
      "2026-08-18T12:34:56.789Z",
      "earn_vault_position_12345678-1234-4234-8234-123456789abc"
    );

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeysetCursor(cursor)).toEqual({
      value: "2026-08-18T12:34:56.789Z",
      id: "earn_vault_position_12345678-1234-4234-8234-123456789abc",
    });
  });

  it.each([
    "",
    "not-base64!",
    btoa("missing-separator"),
    btoa("|missing-value"),
    btoa("missing-id|"),
  ])("rejects a malformed envelope: %s", (cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeNull();
  });
});
