import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maskEmail,
  scrubAuditMetadata,
  scrubError,
  scrubTelemetry,
  scrubTelemetryString,
} from "./scrub";
import { assertScrubbed, COUNTERPARTY_PAYLOAD, SOLANA_ADDRESS } from "./test/fixtures";

describe("scrubTelemetry", () => {
  it("removes every identifying field from the representative payload", () => {
    assertScrubbed(JSON.stringify(scrubTelemetry(COUNTERPARTY_PAYLOAD)));
  });

  it("redacts a value by its key without touching the sibling ids", () => {
    const scrubbed = scrubTelemetry({
      email: "jane.doe@example.com",
      walletAddress: SOLANA_ADDRESS,
      counterpartyId: "cp_01HZY",
    });

    assert.deepEqual(scrubbed, {
      email: "[REDACTED]",
      walletAddress: SOLANA_ADDRESS,
      counterpartyId: "cp_01HZY",
    });
  });

  it("finds email addresses inside free text, where no key can vouch for them", () => {
    // Provider validation errors read like this, and they end up in both a log
    // line and a Sentry issue.
    const scrubbed = scrubTelemetry({
      message: "Counterparty jane.doe@example.com is already registered for USD",
    });

    assert.equal(
      (scrubbed as { message: string }).message,
      "Counterparty [REDACTED_EMAIL] is already registered for USD"
    );
  });

  it("survives a circular payload rather than throwing inside a send path", () => {
    const payload: Record<string, unknown> = { email: "jane.doe@example.com" };
    payload.self = payload;

    assert.deepEqual(scrubTelemetry(payload), { email: "[REDACTED]", self: "[Circular]" });
  });

  it("truncates beyond the depth bound instead of overflowing the stack", () => {
    // A provider webhook body reaches this walker before anything else reads
    // it, so the depth is attacker-controlled.
    let deep: Record<string, unknown> = { email: "jane.doe@example.com" };
    for (let level = 0; level < 40; level += 1) {
      deep = { nested: deep };
    }

    const serialized = JSON.stringify(scrubTelemetry(deep));

    assert.ok(serialized.includes("[Truncated]"));
    assert.ok(!serialized.includes("jane.doe@example.com"));
  });

  it("redacts binary payloads instead of expanding them into digits", () => {
    assert.equal(scrubTelemetry<unknown>(new Uint8Array([1, 2, 3])), "[REDACTED]");
  });

  it("scrubs array members", () => {
    assert.deepEqual(scrubTelemetry([{ phone: "+15551234567" }, { walletId: "wlt_1" }]), [
      { phone: "[REDACTED]" },
      { walletId: "wlt_1" },
    ]);
  });
});

describe("scrubError", () => {
  it("keeps Error identity so pino and Sentry still recognise it", () => {
    const error = new Error("failed for jane.doe@example.com");
    error.name = "CounterpartyError";

    const scrubbed = scrubError(error);

    assert.ok(scrubbed instanceof Error);
    assert.equal(scrubbed.name, "CounterpartyError");
    assert.equal(scrubbed.message, "failed for [REDACTED_EMAIL]");
  });

  it("carries context and cause through, scrubbed", () => {
    // `context` is the @solana/kit shape that makes a chain failure diagnosable.
    const error = new Error("simulation failed") as Error & { context?: unknown };
    error.context = { logs: ["Program log: ok"], email: "jane.doe@example.com" };
    error.cause = new Error("rejected by jane.doe@example.com");

    const scrubbed = scrubError(error) as Error & { context?: unknown; cause?: unknown };

    assert.deepEqual(scrubbed.context, { logs: ["Program log: ok"], email: "[REDACTED]" });
    assert.equal((scrubbed.cause as Error).message, "rejected by [REDACTED_EMAIL]");
  });

  it("scrubs the stack, which repeats the message", () => {
    const error = new Error("jane.doe@example.com not found");

    assert.ok(!scrubError(error).stack?.includes("jane.doe@example.com"));
  });
});

describe("scrubTelemetryString", () => {
  it("strips credentials and emails from a provider message", () => {
    const scrubbed = scrubTelemetryString(
      'Privy API error: {"appSecret":"privy-secret"} for jane.doe@example.com'
    );

    assert.ok(!scrubbed.includes("privy-secret"));
    assert.ok(!scrubbed.includes("jane.doe@example.com"));
    assert.ok(scrubbed.includes("Privy API error"));
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  });

  it("leaves a value that is not an address untouched", () => {
    assert.equal(maskEmail("Team member"), "Team member");
  });

  it("does not re-mask an already masked value", () => {
    assert.equal(maskEmail("j***@example.com"), "j***@example.com");
  });
});

describe("scrubAuditMetadata", () => {
  it("masks the email so an invitation row still names its subject", () => {
    const scrubbed = scrubAuditMetadata({ email: "jane.doe@example.com", role: "admin" });

    assert.deepEqual(scrubbed, { email: "j***@example.com", role: "admin" });
  });

  it("redacts identifying fields that are not addresses", () => {
    const scrubbed = scrubAuditMetadata({
      identity: { firstName: "Jane", dateOfBirth: "1988-04-02" },
      phone: "+15551234567",
      resourceId: "cp_01HZY",
    });

    assert.deepEqual(scrubbed, {
      identity: "[REDACTED]",
      phone: "[REDACTED]",
      resourceId: "cp_01HZY",
    });
  });

  it("masks addresses found in free-text metadata too", () => {
    const scrubbed = scrubAuditMetadata({ reason: "invited jane.doe@example.com by mistake" });

    assert.deepEqual(scrubbed, { reason: "invited j***@example.com by mistake" });
  });
});
