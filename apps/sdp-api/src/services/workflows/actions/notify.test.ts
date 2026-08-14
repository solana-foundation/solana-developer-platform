import { describe, expect, it } from "vitest";
import { TransactionalEmailError } from "@/services/email";
import { isPermanentEmailError } from "./notify";

describe("isPermanentEmailError", () => {
  it("keeps transport errors retryable, 4xx-looking substrings included", () => {
    // The old regex classifier matched \b4\d\d\b — a port number in a connection
    // error permanently killed a send that a retry would have fixed.
    expect(isPermanentEmailError(new Error("connect ECONNREFUSED 10.0.0.5:465"))).toBe(false);
    expect(isPermanentEmailError(new Error("fetch failed"))).toBe(false);
    expect(isPermanentEmailError("not even an Error")).toBe(false);
  });

  it("treats provider 4xx as permanent, except 429 backpressure", () => {
    expect(
      isPermanentEmailError(
        new TransactionalEmailError("delivery_failed", "domain is not verified", { status: 422 })
      )
    ).toBe(true);
    expect(
      isPermanentEmailError(
        new TransactionalEmailError("delivery_failed", "rate limit exceeded", { status: 429 })
      )
    ).toBe(false);
    expect(
      isPermanentEmailError(
        new TransactionalEmailError("delivery_failed", "internal error", { status: 500 })
      )
    ).toBe(false);
    expect(
      isPermanentEmailError(new TransactionalEmailError("delivery_failed", "no status at all"))
    ).toBe(false);
  });

  it("treats config and payload errors as permanent", () => {
    expect(
      isPermanentEmailError(new TransactionalEmailError("misconfigured", "EMAIL_FROM is required"))
    ).toBe(true);
    expect(
      isPermanentEmailError(new TransactionalEmailError("invalid_message", "no recipients"))
    ).toBe(true);
  });
});
