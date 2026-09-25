import { describe, expect, it } from "vitest";
import { KNOWN_INTEGRATION_SUITES, parseRequestedSuites } from "./preflight";

describe("parseRequestedSuites", () => {
  it("returns null when SDP_INTEGRATION_SUITE is unset or blank", () => {
    expect(parseRequestedSuites(undefined)).toBeNull();
    expect(parseRequestedSuites("   ")).toBeNull();
  });

  it("parses trimmed, lowercased, comma-separated suite names", () => {
    expect(parseRequestedSuites(" Kora, spc ,DVP")).toEqual(new Set(["kora", "spc", "dvp"]));
  });

  it("rejects an unrecognized suite name instead of silently running no suite", () => {
    // Regression (review of APE-722): a typo like `korra` used to produce an
    // empty scope, the preflight no-opped, and the run went green with every
    // test skipped.
    expect(() => parseRequestedSuites("korra")).toThrow(
      /unrecognized SDP_INTEGRATION_SUITE value\(s\): korra/
    );
  });

  it("rejects an unrecognized name mixed with known ones", () => {
    expect(() => parseRequestedSuites("kora,korra")).toThrow(/korra/);
  });

  it("covers every documented suite", () => {
    expect(KNOWN_INTEGRATION_SUITES).toEqual(["kora", "spc", "dvp"]);
  });
});
