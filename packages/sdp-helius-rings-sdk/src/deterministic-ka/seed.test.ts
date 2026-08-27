import { describe, expect, it } from "vitest";
import { decodeSeed } from "./seed.js";

describe("decodeSeed", () => {
  it("decodes 32 base64-encoded bytes", () => {
    const seed = new Uint8Array(32).fill(7);

    expect(decodeSeed(Buffer.from(seed).toString("base64"))).toStrictEqual(seed);
  });

  it("rejects a missing seed", () => {
    expect(() => decodeSeed(undefined)).toThrow(/required/);
    expect(() => decodeSeed("")).toThrow(/required/);
  });

  it("rejects a seed that is not base64", () => {
    expect(() => decodeSeed("not base64 at all!!")).toThrow(/base64/);
  });

  it("rejects a seed of the wrong length", () => {
    expect(() => decodeSeed(Buffer.alloc(31).fill(1).toString("base64"))).toThrow(/32 bytes/);
  });

  it("rejects the all-zero placeholder", () => {
    expect(() => decodeSeed(Buffer.alloc(32).toString("base64"))).toThrow(/placeholder/);
  });
});
