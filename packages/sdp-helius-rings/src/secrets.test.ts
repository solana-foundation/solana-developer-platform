import { describe, expect, it } from "vitest";
import { SecretRef } from "./secrets";

describe("SecretRef", () => {
  it("redacts under JSON.stringify at every nesting depth", () => {
    const ref = new SecretRef("hunter2");
    expect(JSON.stringify(ref)).toBe('"[REDACTED]"');
    expect(JSON.stringify({ password: ref })).toBe('{"password":"[REDACTED]"}');
    expect(JSON.stringify({ outer: { inner: ref } })).not.toContain("hunter2");
  });

  it("redacts under template literals and explicit toString", () => {
    const ref = new SecretRef("hunter2");
    expect(`${ref}`).toBe("[REDACTED]");
    expect(String(ref)).toBe("[REDACTED]");
    expect(ref.toString()).toBe("[REDACTED]");
  });

  it("returns the wrapped value only via reveal()", () => {
    const payload = { inner: "hunter2" };
    const ref = new SecretRef(payload);
    expect(ref.reveal("test")).toBe(payload);
  });

  it("wraps non-string payloads without leaking them", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ref = new SecretRef(bytes);
    expect(JSON.stringify(ref)).toBe('"[REDACTED]"');
    expect(ref.reveal("adapter")).toBe(bytes);
  });
});
