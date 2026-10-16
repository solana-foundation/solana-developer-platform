import { describe, expect, it } from "vitest";
import {
  resolveCompletionOutcome,
  resolveHttpOutcome,
  resolveRotationOutcome,
} from "./verification-outcome";

describe("verification outcomes", () => {
  it("has nothing to report for a success or a check still running", () => {
    expect(resolveCompletionOutcome(null)).toBeNull();
    expect(
      resolveCompletionOutcome({ status: "success", attemptedAt: "2026-09-09T14:20:00.000Z" })
    ).toBeNull();
    expect(
      resolveCompletionOutcome({ status: "running", attemptedAt: "2026-09-09T14:20:00.000Z" })
    ).toBeNull();
    expect(resolveRotationOutcome({ status: "success" })).toBeNull();
  });

  it("separates a rejected credential from one that opens a different account", () => {
    expect(
      resolveCompletionOutcome({
        status: "failed",
        attemptedAt: "2026-09-09T14:20:00.000Z",
        code: "invalid_credentials",
      })
    ).toMatchObject({ kind: "invalid_credentials", tone: "danger" });

    expect(
      resolveCompletionOutcome({
        status: "failed",
        attemptedAt: "2026-09-09T14:20:00.000Z",
        code: "provider_account_already_connected",
      })
    ).toMatchObject({ kind: "account_mismatch", tone: "danger" });

    // The rotation route spells the same situation differently.
    expect(
      resolveRotationOutcome({ status: "failed", code: "provider_account_mismatch" })
    ).toMatchObject({ kind: "account_mismatch", tone: "danger" });
  });

  it("never paints an unconfirmed outcome as a failure", () => {
    const fromCompletion = resolveCompletionOutcome({
      status: "retry_unknown",
      attemptedAt: "2026-09-09T14:20:00.000Z",
    });
    const fromRotation = resolveRotationOutcome({
      status: "retry_unknown",
      code: "provider_response_unknown",
    });

    for (const outcome of [fromCompletion, fromRotation]) {
      expect(outcome).toMatchObject({ kind: "unknown", tone: "neutral" });
      expect(outcome?.tone).not.toBe("danger");
      expect(outcome?.actions).toEqual(["check_current_state"]);
    }
  });

  it("offers no retry for a wallet conflict, which retrying cannot resolve", () => {
    const outcome = resolveCompletionOutcome({
      status: "failed",
      attemptedAt: "2026-09-09T14:20:00.000Z",
      code: "wallet_conflict",
    });

    expect(outcome).toMatchObject({ kind: "wallet_conflict", retryable: false });
    expect(outcome?.actions).toEqual(["copy_connection_id", "contact_support"]);
  });

  it("treats a failure with an unfamiliar code as conclusive, not unknown", () => {
    expect(
      resolveCompletionOutcome({
        status: "failed",
        attemptedAt: "2026-09-09T14:20:00.000Z",
        code: "something_new",
      })
    ).toMatchObject({ kind: "invalid_credentials" });
  });

  describe("transport answers", () => {
    it("calls a conflict a concurrent change rather than a failure of this request", () => {
      expect(resolveHttpOutcome(409)).toMatchObject({ kind: "conflict", tone: "warning" });
    });

    it("marks timeouts, rate limits and provider outages retryable", () => {
      for (const status of [408, 429, 503]) {
        expect(resolveHttpOutcome(status)).toMatchObject({ kind: "temporary", tone: "info" });
      }
    });

    it("leaves a lost response or a server error open", () => {
      // 0 stands for "no response arrived", which is the case where the write
      // most plausibly committed anyway.
      expect(resolveHttpOutcome(0)).toMatchObject({ kind: "unknown", tone: "neutral" });
      expect(resolveHttpOutcome(500)).toMatchObject({ kind: "unknown", tone: "neutral" });
    });

    it("treats an ordinary 4xx as a conclusive rejection", () => {
      expect(resolveHttpOutcome(400)).toMatchObject({ kind: "invalid_credentials" });
    });
  });
});
