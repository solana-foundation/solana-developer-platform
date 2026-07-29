import { describe, expect, it } from "vitest";
import { setNestedValue } from "./set-nested-value";

describe("setNestedValue", () => {
  it("assigns a top-level key", () => {
    const target: Record<string, unknown> = {};
    setNestedValue(target, "name", "USDC");
    expect(target).toEqual({ name: "USDC" });
  });

  it("creates intermediate objects for a dot path", () => {
    const target: Record<string, unknown> = {};
    setNestedValue(target, "asset.metadata.symbol", "USDC");
    expect(target).toEqual({ asset: { metadata: { symbol: "USDC" } } });
  });

  it("replaces a non-object intermediate value", () => {
    const target: Record<string, unknown> = { asset: "string" };
    setNestedValue(target, "asset.symbol", "USDC");
    expect(target).toEqual({ asset: { symbol: "USDC" } });
  });

  it("does not pollute Object.prototype via a __proto__ path", () => {
    const target: Record<string, unknown> = {};
    setNestedValue(target, "__proto__.polluted", "yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({});
  });

  it("ignores paths containing constructor or prototype segments", () => {
    const target: Record<string, unknown> = {};
    setNestedValue(target, "constructor.prototype.polluted", "yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(target).toEqual({});
  });

  it("does not pollute via a __proto__ segment nested inside the path", () => {
    const target: Record<string, unknown> = {};
    setNestedValue(target, "asset.__proto__.polluted", "yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
