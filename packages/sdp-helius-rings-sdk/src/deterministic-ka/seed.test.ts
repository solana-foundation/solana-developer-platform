import { describe, expect, it, vi } from "vitest";
import { DETERMINISTIC_KA_SEED, SEED_BYTE_LENGTH, warnDeterministicKeyAuthority } from "./seed.js";

describe("DETERMINISTIC_KA_SEED", () => {
  it("is the length the derivation requires", () => {
    expect(DETERMINISTIC_KA_SEED).toHaveLength(SEED_BYTE_LENGTH);
  });

  it("reads as a test value, so it cannot be mistaken for a configured secret", () => {
    expect(new TextDecoder().decode(DETERMINISTIC_KA_SEED)).toBe(
      "INSECURE_TEST_SEED_DEVNET_ONLY!!"
    );
  });
});

describe("warnDeterministicKeyAuthority", () => {
  it("warns once per process rather than once per wallet", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnDeterministicKeyAuthority();
    warnDeterministicKeyAuthority();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("INSECURE");
    warn.mockRestore();
  });
});
