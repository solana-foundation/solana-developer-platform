import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactCredentialString } from "./credentials";
import {
  maskEmail,
  scrubAuditMetadata,
  scrubError,
  scrubTelemetry,
  scrubTelemetryString,
} from "./scrub";
import {
  assertScrubbed,
  COUNTERPARTY_PAYLOAD,
  OWNER_ADDRESS,
  SOLANA_ADDRESS,
} from "./test/fixtures";

describe("scrubTelemetry", () => {
  it("redacts pay-link bearer tokens in paths, URLs and errors while retaining route context", () => {
    const token = "synthetic-pay-link-credential";
    const result = scrubTelemetry({
      path: `/pay/${token}`,
      url: new URL(`https://api.example.com/pay/${token}/tx`),
      error: new Error(`GET /pay/${token}/missing returned 404`),
      resourcePath: "/v1/payments/requests/preq_1",
    });

    assert.equal(result.path, "/pay/[REDACTED]");
    assert.equal(result.url, "https://api.example.com/pay/[REDACTED]/tx");
    assert.equal(result.error.message, "GET /pay/[REDACTED]/missing returned 404");
    assert.ok(!result.error.stack?.includes(token));
    assert.equal(result.resourcePath, "/v1/payments/requests/preq_1");
    assert.ok(!JSON.stringify(result).includes(token));
  });

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

  it("redacts key material by key, including the Solana keypair JSON field name", () => {
    // `secretKey` is the field a Solana keypair JSON file uses for the full
    // 64-byte secret; `mnemonic` and `seedPhrase` are the recovery-secret
    // spellings. A sibling resource id stays readable.
    const scrubbed = scrubTelemetry({
      secretKey: "jZ2ZCg8BfJqknAfGCgerDECGjTzXAHAqdBPLDdBZqMkEAAAAAAAAAAQ==",
      signingKeyId: "sk_01HZY",
      mnemonic: "test test test test test test test test test test bottom brake",
      seedPhrase: "test test test test test test test test test test bottom brake",
    });

    assert.deepEqual(scrubbed, {
      secretKey: "[REDACTED]",
      signingKeyId: "sk_01HZY",
      mnemonic: "[REDACTED]",
      seedPhrase: "[REDACTED]",
    });
  });

  it("redacts an end-user owner address by key while the treasury address survives", () => {
    const scrubbed = scrubTelemetry({
      event: "sdp_api_earn_split_swap_orphaned",
      advisory_id: "adv_01HZY",
      owner_address: OWNER_ADDRESS,
      vault_address: SOLANA_ADDRESS,
    });

    assert.deepEqual(scrubbed, {
      event: "sdp_api_earn_split_swap_orphaned",
      advisory_id: "adv_01HZY",
      owner_address: "[REDACTED]",
      vault_address: SOLANA_ADDRESS,
    });
  });

  it("redacts an owner address written into a query string or a serialized body", () => {
    // The per-owner position read takes `?ownerAddress=`, so a logged URL or
    // an echoed request body carries the end user without any object key.
    assert.equal(
      scrubTelemetryString(
        `GET /v1/earn/external-wallet/positions?ownerAddress=${OWNER_ADDRESS}&strategyId=str_1`
      ),
      "GET /v1/earn/external-wallet/positions?ownerAddress=[REDACTED]&strategyId=str_1"
    );
    assert.equal(
      scrubTelemetryString(
        `{"ownerAddress":"${OWNER_ADDRESS}","vaultAddress":"${SOLANA_ADDRESS}"}`
      ),
      `{"ownerAddress":"[REDACTED]","vaultAddress":"${SOLANA_ADDRESS}"}`
    );
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

describe("scrubTelemetryString — prefixed keys in a serialized body", () => {
  // The object-key rules match by suffix (`isPiiKey`), so the string rules have
  // to as well, or the same field leaks purely by having been stringified first.
  it("redacts a prefixed PII key, not just the bare name", () => {
    const scrubbed = scrubTelemetryString('{"counterparty-email":"jane.doe@example.com"}');

    assert.ok(!scrubbed.includes("jane.doe@example.com"));
  });

  it("redacts a prefixed credential key in its quoted form", () => {
    const scrubbed = scrubTelemetryString('{"x-api-key":"sk_live_supersecret"}');

    assert.ok(!scrubbed.includes("sk_live_supersecret"));
    assert.ok(scrubbed.includes("x-api-key"));
  });

  it("keeps a key that merely contains a denied name as a prefix", () => {
    // `tokenName` ends in `name`, which is deliberately never denied, and the
    // prefix group must not reach across the `:` into the next field either.
    const scrubbed = scrubTelemetryString(`{"tokenName":"USD Coin","mint":"${SOLANA_ADDRESS}"}`);

    assert.ok(scrubbed.includes("USD Coin"));
    assert.ok(scrubbed.includes(SOLANA_ADDRESS));
  });
});

describe("redactCredentialString: escaped quotes", () => {
  // A quoted value ends at its first unescaped quote. Stopping at an escaped one
  // left the rest of the secret in the message (APE-827).
  it("redacts past an escaped quote inside the value", () => {
    assert.equal(
      redactCredentialString('{"secret":"prefix\\"provider-secret"}'),
      '{"secret":"[REDACTED]"}'
    );
  });

  it("ends the value at a quote that follows an escaped backslash", () => {
    assert.equal(
      redactCredentialString(`{"secret":"a\\\\","mint":"${SOLANA_ADDRESS}"}`),
      `{"secret":"[REDACTED]","mint":"${SOLANA_ADDRESS}"}`
    );
  });

  it("redacts a field serialized twice", () => {
    const redacted = redactCredentialString('{\\"secret\\":\\"provider-secret\\",\\"a\\":1}');

    assert.ok(!redacted.includes("provider-secret"), redacted);
    assert.ok(redacted.includes('\\"a\\":1'), redacted);
  });

  it("keeps the telemetry scrub closed on the same input", () => {
    assert.ok(
      !scrubTelemetryString('{"secret":"prefix\\"provider-secret"}').includes("provider-secret")
    );
  });

  it("redacts an escaped quote inside a field serialized twice", () => {
    const redacted = redactCredentialString(
      JSON.stringify(JSON.stringify({ secret: 'prefix"provider-secret' }))
    );

    assert.ok(!redacted.includes("provider-secret"), redacted);
  });

  for (const depth of [1, 2, 3]) {
    it(`redacts at serialization depth ${depth} and keeps the next field`, () => {
      let body: string = JSON.stringify({ secret: 'pre"fix\\provider-secret', note: "kept" });
      for (let level = 1; level < depth; level += 1) {
        body = JSON.stringify(body);
      }

      const redacted = redactCredentialString(body);

      assert.ok(!redacted.includes("provider-secret"), redacted);
      assert.ok(redacted.includes("kept"), redacted);
    });
  }

  it("redacts a value that never closes", () => {
    assert.equal(redactCredentialString('{"secret":"provider-sec'), '{"secret":"[REDACTED]');
  });

  it("scans a long backslash run in linear time", () => {
    const payload = `${"\\".repeat(200_000)}x`;

    const startedAt = process.hrtime.bigint();
    redactCredentialString(payload);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(elapsedMs < 1_000, `expected a linear scan, took ${elapsedMs.toFixed(0)}ms`);
  });

  it("scans an unterminated escaped value in linear time", () => {
    const payload = `{"secret":"${'\\"'.repeat(100_000)}`;

    const startedAt = process.hrtime.bigint();
    redactCredentialString(payload);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(elapsedMs < 1_000, `expected a linear scan, took ${elapsedMs.toFixed(0)}ms`);
  });
});

describe("redactCredentialString: Clerk invitation tickets", () => {
  const ticket = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0aWNrZXRfc3ludGhldGljIn0.c3ludGhldGljX3NpZw";

  for (const { form, input, redacted } of [
    {
      form: "plain",
      input: `https://dash.example.test/sign-in?__clerk_ticket=${ticket}&x=1`,
      redacted: "https://dash.example.test/sign-in?__clerk_ticket=[REDACTED]&x=1",
    },
    {
      form: "URL-encoded inside redirect_url",
      input: `https://dash.example.test/sign-in?redirect_url=https%3A%2F%2Fdash.example.test%2Fdashboard%3F__clerk_ticket%3D${ticket}%26x%3D1`,
      redacted:
        "https://dash.example.test/sign-in?redirect_url=https%3A%2F%2Fdash.example.test%2Fdashboard%3F__clerk_ticket%3D[REDACTED]%26x%3D1",
    },
    {
      form: "double-encoded",
      input: `https://dash.example.test/sign-in?next=%253F__clerk_ticket%253D${ticket}%2526x%253D1`,
      redacted:
        "https://dash.example.test/sign-in?next=%253F__clerk_ticket%253D[REDACTED]%2526x%253D1",
    },
    {
      form: "JSON field",
      input: `{"__clerk_ticket":"${ticket}","x":1}`,
      redacted: '{"__clerk_ticket":"[REDACTED]","x":1}',
    },
    {
      form: "JSON field escaped inside a JSON string",
      input: `{"msg":"{\\"__clerk_ticket\\":\\"${ticket}\\",\\"x\\":1}"}`,
      redacted: '{"msg":"{\\"__clerk_ticket\\":\\"[REDACTED]\\",\\"x\\":1}"}',
    },
  ]) {
    it(`redacts the ${form} ticket and keeps the rest intact`, () => {
      assert.equal(redactCredentialString(input), redacted);
    });
  }
});

describe("scrubTelemetryString — pathological input", () => {
  // Regression guard for a quadratic rescan (CodeQL js/polynomial-redos): the
  // email pattern's local part used to be retried at every offset inside one
  // unbroken run. A webhook body reaches this walker before anything else reads
  // it, so 160KB of "%" was ~41s of blocked event loop.
  it("scrubs a long run of local-part characters in linear time", () => {
    const payload = "%".repeat(200_000);

    const startedAt = process.hrtime.bigint();
    scrubTelemetryString(payload);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    assert.ok(
      elapsedMs < 1_000,
      `expected a linear scan, took ${elapsedMs.toFixed(0)}ms (quadratic regression)`
    );
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    assert.equal(maskEmail("jane.doe@example.com"), "j***@example.com");
  });

  it("still finds an address that is not at a word boundary the lookbehind rejects", () => {
    // The anti-backtracking lookbehind must not make a real address unmatchable
    // when it is butted up against surrounding punctuation.
    assert.equal(maskEmail("<jane@example.com>"), "<j***@example.com>");
    assert.equal(
      maskEmail("jane+tag@sub.example.com,bob@other.org"),
      "j***@sub.example.com,b***@other.org"
    );
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
