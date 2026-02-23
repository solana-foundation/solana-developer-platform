import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  getNestedProp,
  hexToBytes,
  normalizeHex,
  resolveRequestUrl,
} from "../utils.js";

describe("utils", () => {
  it("preserves base path when resolving request URLs", () => {
    const { requestPath, url } = resolveRequestUrl("https://api.getpara.com/v2", "/v1/wallets/abc");

    expect(url.toString()).toBe("https://api.getpara.com/v2/v1/wallets/abc");
    expect(requestPath).toBe("/v2/v1/wallets/abc");
  });

  it("normalizes prefixed hex strings", () => {
    expect(normalizeHex("0xdeadbeef")).toBe("deadbeef");
    expect(normalizeHex("deadbeef")).toBe("deadbeef");
  });

  it("encodes and decodes hex", () => {
    const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe("000102fdfeff");
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
    expect(Array.from(hexToBytes(`0x${hex}`))).toEqual(Array.from(bytes));
  });

  it("reads nested values safely", () => {
    const value = getNestedProp<string>({ data: { signature: "abc" } }, "data.signature");
    expect(value).toBe("abc");
  });
});
