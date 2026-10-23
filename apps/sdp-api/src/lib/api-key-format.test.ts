import { describe, expect, it } from "vitest";
import {
  crc32,
  formatSfApiKey,
  generateSfApiKey,
  looksLikeApiKey,
  parsePresentedApiKey,
  parseSfApiKey,
} from "./api-key-format";

// Known-answer vectors, computed independently (Python zlib.crc32 and base62
// over 0-9A-Za-z). They pin the layout the gateway must also verify.
const FIRST_VECTOR = {
  keyId: "0018a3cae6a0a034",
  secret: "sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI",
  key: "sf_0018a3cae6a0a034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh3",
};
const VECTORS = [
  FIRST_VECTOR,
  {
    keyId: "0000000000000000",
    secret: "0000000000000000000000000000000000000000000",
    key: "sf_0000000000000000_00000000000000000000000000000000000000000001ChfYt",
  },
];

describe("crc32", () => {
  it("matches the IEEE check value", () => {
    expect(crc32("123456789")).toBe(0xcbf43926);
  });
});

describe("sf_ keys", () => {
  it.each(VECTORS)("formats and parses $key", ({ keyId, secret, key }) => {
    expect(formatSfApiKey({ keyId, secret })).toBe(key);
    expect(parseSfApiKey(key)).toEqual({ keyId, secret });
  });

  it("generates keys that parse back to their parts", () => {
    for (let i = 0; i < 50; i++) {
      const { key, keyId, secret } = generateSfApiKey();
      expect(key).toHaveLength(3 + 16 + 1 + 43 + 6);
      expect(parseSfApiKey(key)).toEqual({ keyId, secret });
    }
  });

  it("rejects a typo through the checksum", () => {
    const { key } = FIRST_VECTOR;
    const typo = `${key.slice(0, 30)}${key[30] === "a" ? "b" : "a"}${key.slice(31)}`;
    expect(parseSfApiKey(typo)).toBeNull();
  });

  it.each([
    "sf_0018A3CAE6A0A034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh3",
    "sf_0018a3cae6a0a034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh",
    "sf_0018a3cae6a0a034_sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDU-3NoYh3",
    "sf_0018a3cae6a0a034sc7Mv6ineTCew5AEgraQLmN8OgapWiFzDF9DUPEXDUI3NoYh3",
    "sf_",
  ])("rejects malformed %s", (token) => {
    expect(parseSfApiKey(token)).toBeNull();
  });
});

describe("parsePresentedApiKey", () => {
  it("classifies sf_ and legacy keys", () => {
    const { key, keyId, secret } = FIRST_VECTOR;
    expect(parsePresentedApiKey(key)).toEqual({ format: "sf", keyId, secret });
    expect(parsePresentedApiKey("sk_live_abc")).toEqual({ format: "legacy", key: "sk_live_abc" });
    expect(parsePresentedApiKey("sk_test_abc")).toEqual({ format: "legacy", key: "sk_test_abc" });
  });

  it("refuses anything else, including an sf_ key with a bad checksum", () => {
    expect(parsePresentedApiKey("sk_prod_abc")).toBeNull();
    expect(parsePresentedApiKey("sf_bad")).toBeNull();
    expect(parsePresentedApiKey("pk_live_abc")).toBeNull();
  });
});

describe("looksLikeApiKey", () => {
  it("accepts both prefixes", () => {
    expect(looksLikeApiKey("sf_x")).toBe(true);
    expect(looksLikeApiKey("sk_x")).toBe(true);
    expect(looksLikeApiKey("eyJ.a.b")).toBe(false);
  });
});
