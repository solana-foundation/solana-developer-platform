import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeDemoOps, encodeDemoOps, MAX_DECODED_LENGTH } from "./demo-session";

/*
 * The session cookies are the browser's to send, so reading them must stay cheap whatever they
 * hold: a small cookie that inflates into megabytes reads as an empty session.
 */

const contact = (index: number) => ({
  k: "contact" as const,
  id: `demo_new_cpty_${index}`,
  at: index,
  name: `Contact ${index}`,
  entity: "individual" as const,
  ext: null,
});

describe("demo session cookies", () => {
  it("counts the log in bytes, so a multi-byte log is not lost on the next read", () => {
    // Each name is 40 characters but 120 bytes: past the byte budget, within the character one.
    const ops = Array.from({ length: 400 }, (_, index) => ({
      ...contact(index),
      name: "\u65e5".repeat(40),
    }));
    const json = JSON.stringify(ops);
    expect(json.length).toBeLessThan(MAX_DECODED_LENGTH);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_DECODED_LENGTH);
    const read = decodeDemoOps(encodeDemoOps(ops));
    expect(read.length).toBeGreaterThan(0);
    expect(read.at(-1)).toEqual(ops.at(-1));
  });

  it("reads nothing from no cookies, or from ones that aren't a session", () => {
    expect(decodeDemoOps([])).toEqual([]);
    expect(decodeDemoOps(["not base64 deflate"])).toEqual([]);
    expect(decodeDemoOps([deflateRawSync('{"k":"contact"}').toString("base64url")])).toEqual([]);
  });

  it("refuses a cookie that inflates past the budget", () => {
    const bomb = deflateRawSync(`[${" ".repeat(MAX_DECODED_LENGTH * 4)}]`).toString("base64url");
    expect(bomb.length).toBeLessThan(3600);
    expect(decodeDemoOps([bomb])).toEqual([]);
  });

  it("refuses more encoded text than the chunks may carry", () => {
    expect(decodeDemoOps(["a".repeat(3600 * 3 + 1)])).toEqual([]);
  });

  it("keeps the newest actions when the log's JSON outgrows the budget", () => {
    // Highly compressible, so only the decoded budget trims it.
    const ops = Array.from({ length: 2_000 }, (_, index) => contact(index));
    const chunks = encodeDemoOps(ops);
    const decoded = decodeDemoOps(chunks);
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.length).toBeLessThan(ops.length);
    expect(JSON.stringify(decoded).length).toBeLessThanOrEqual(MAX_DECODED_LENGTH);
    expect(decoded.at(-1)).toEqual(ops.at(-1));
  });
});
