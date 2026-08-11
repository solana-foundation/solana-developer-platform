import { describe, expect, it } from "vitest";
import { HeliusRingsError } from "./errors";

describe("HeliusRingsError", () => {
  it("preserves the code, name, and message", () => {
    const err = new HeliusRingsError("gateway_unavailable", "gateway down");
    expect(err.code).toBe("gateway_unavailable");
    expect(err.message).toBe("gateway down");
    expect(err.name).toBe("HeliusRingsError");
    expect(err).toBeInstanceOf(Error);
  });

  it("forwards the cause option", () => {
    const cause = new Error("upstream");
    const err = new HeliusRingsError("config_error", "bad config", { cause });
    expect(err.cause).toBe(cause);
  });
});
