import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactCredentialSecrets, redactCredentialString } from "./credentials";
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

const FAKE_PASSWORD = "not-a-real-pass";

/** Builds a URL with userinfo at runtime, so no credential URL sits in source. */
function credentialUrl(
  scheme: string,
  user: string,
  rest: string,
  password = FAKE_PASSWORD
): string {
  return `${scheme}://${user}:${password}@${rest}`;
}

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
      secretKey: "not-a-real-key-material",
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

  it("redacts a bare derivation seed and a wallet passphrase by key", () => {
    // A signer helper that logs its derivation input does so under `seed`,
    // and custodian configs carry `walletPassphrase` — both key material no
    // suffix rule catches. A sibling PDA `seeds` array is public derivation
    // data and survives.
    const scrubbed = scrubTelemetry({
      seed: "not-a-real-key-material",
      walletPassphrase: "correct horse battery staple",
      seeds: ["owner", "aux"],
    });

    assert.deepEqual(scrubbed, {
      seed: "[REDACTED]",
      walletPassphrase: "[REDACTED]",
      seeds: ["owner", "aux"],
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
      'Privy API error: {"appSecret":"not-a-real-app-secret"} for jane.doe@example.com'
    );

    assert.ok(!scrubbed.includes("not-a-real-app-secret"));
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
    const scrubbed = scrubTelemetryString('{"x-api-key":"not-a-real-api-key"}');

    assert.ok(!scrubbed.includes("not-a-real-api-key"));
    assert.ok(scrubbed.includes("x-api-key"));
  });

  it("redacts a cookie that arrives inside a serialized header blob", () => {
    // A Sentry request-header dump serializes headers to a string, where the
    // object-key `cookie` rule cannot reach; the string forms have to cover it.
    const scrubbed = scrubTelemetryString(
      '{"headers":{"accept":"*/*","cookie":"session=supersecret-value"}}'
    );

    assert.ok(!scrubbed.includes("supersecret-value"));
    assert.ok(scrubbed.includes("cookie"));

    const assignment = scrubTelemetryString("Cookie: session=supersecret-value; theme=dark");

    assert.ok(!assignment.includes("supersecret-value"));
  });

  it("redacts every cookie pair in a raw header, not only the one before the first space", () => {
    // The generic assignment rule's value stops at whitespace, so a session
    // cookie that is not the first pair — and every pair after it — stayed
    // readable. A cookie header is one credential blob; the rule consumes it
    // to the end of the line.
    const scrubbed = scrubTelemetryString("Cookie: theme=dark; session=supersecret-value");

    assert.ok(!scrubbed.includes("supersecret-value"));
    assert.ok(!scrubbed.includes("theme=dark"));
    assert.ok(scrubbed.includes("Cookie:"));

    const twoCookies = scrubTelemetryString("Cookie: session=first; refresh=second");

    assert.ok(!twoCookies.includes("first"));
    assert.ok(!twoCookies.includes("second"));
  });

  it("keeps the fields that follow a cookie header inside a serialized message", () => {
    // Whole-line matching is only correct for a raw header. An embedded header
    // ends where its containing string ends: stopping at the line end erased
    // `status` and the closing quotes, hiding the error details the message
    // carried.
    const scrubbed = scrubTelemetryString(
      '{"message":"Cookie: session=supersecret-value","status":502}'
    );

    assert.equal(scrubbed, '{"message":"Cookie: [REDACTED]","status":502}');
  });

  it("does not end an embedded cookie value at an escaped quote", () => {
    // Quotes inside a serialized string are escaped; only the string's own
    // closing quote ends the value. Ending early would leak the tail of the
    // header, and the escaped quotes themselves stay inside the redaction.
    const scrubbed = scrubTelemetryString(
      '{"message":"Cookie: session=abc; note=\\"hello\\"","status":502}'
    );

    assert.ok(!scrubbed.includes("hello"));
    assert.ok(!scrubbed.includes("session=abc"));
    assert.ok(scrubbed.includes('"status":502}'));
  });

  it("consumes quoted cookie values in a raw header instead of stopping at a quote", () => {
    // The boundary that preserves serialized structure must not fire on a raw
    // header: a quoted value followed by another pair would otherwise leak the
    // second credential.
    const scrubbed = scrubTelemetryString('Cookie: session="abc"; refresh="def"');

    assert.ok(!scrubbed.includes("abc"));
    assert.ok(!scrubbed.includes("def"));
    assert.ok(scrubbed.includes("Cookie:"));
  });

  it("redacts a seed and a passphrase in a serialized body while public seeds survive", () => {
    // The object-key rules catch a scrubbed object, but a log argument that
    // is already a string — a serialized body, an error message carrying one
    // — only passes through the string patterns, so the same names have to
    // live there too. The bare `seed` stays exact-only: a PDA `seeds` array
    // is public derivation data.
    const scrubbed = scrubTelemetryString(
      '{"seed":"not-a-real-seed-value","walletPassphrase":"correct horse battery staple"}'
    );

    assert.ok(!scrubbed.includes("not-a-real-seed-value"));
    assert.ok(!scrubbed.includes("correct horse battery staple"));
    assert.ok(scrubbed.includes('"seed"'));
    assert.ok(scrubbed.includes("walletPassphrase"));

    const assignments = scrubTelemetryString(
      "seed=not-a-real-seed; walletPassphrase=correct-horse"
    );

    assert.ok(!assignments.includes("not-a-real-seed"));
    assert.ok(!assignments.includes("correct-horse"));

    const publicSeeds = scrubTelemetryString('{"seeds":["owner","aux"]}');

    assert.ok(publicSeeds.includes('"seeds":["owner","aux"]'));
  });

  it("redacts every word of a space-separated mnemonic or passphrase assignment", () => {
    // The generic assignment rule's value stops at the first space, which is
    // exactly where a recovery secret keeps going: an interpolated mnemonic or
    // passphrase kept every word after the first readable.
    const scrubbed = scrubTelemetryString(
      "seed=alpha bravo charlie delta echo foxtrot golf hotel alpha bravo charlie india"
    );

    assert.equal(scrubbed, "seed=[REDACTED]");

    const passphrase = scrubTelemetryString("walletPassphrase=correct horse battery staple");

    assert.equal(passphrase, "walletPassphrase=[REDACTED]");

    const mnemonic = scrubTelemetryString("mnemonic=alpha bravo charlie india");

    assert.equal(mnemonic, "mnemonic=[REDACTED]");
  });

  it("redacts every word across runs of whitespace — double spaces and tabs", () => {
    // The continuation between words was one literal space, so a value
    // formatted with a double space or a tab — exactly how a formatted
    // mnemonic or passphrase renders — stopped redacting at the wide
    // separator and left the words after it readable.
    const doubleSpaced = scrubTelemetryString("seed=alpha  bravo charlie delta");

    assert.equal(doubleSpaced, "seed=[REDACTED]");

    const passphrase = scrubTelemetryString("walletPassphrase=correct  horse battery staple");

    assert.equal(passphrase, "walletPassphrase=[REDACTED]");

    const tabbed = scrubTelemetryString("walletPassphrase=correct\thorse battery staple");

    assert.equal(tabbed, "walletPassphrase=[REDACTED]");

    const mixed = scrubTelemetryString("passphrase=alpha\t beta  gamma");

    assert.equal(mixed, "passphrase=[REDACTED]");
  });

  it("ends a space-separated assignment value at the next assignment, not inside it", () => {
    // The value must not swallow a following pair: the pair's key stays
    // structured and its own value is still redacted by the generic rule.
    const scrubbed = scrubTelemetryString("seed=alpha bravo charlie india token=not-a-real-token");

    assert.equal(scrubbed, "seed=[REDACTED] token=[REDACTED]");
  });

  it("ends a space-separated assignment value before a complete credential name", () => {
    // The boundary must not fall inside a multi-word credential name: a word
    // followed by a space used to read as more value, so
    // `password=foo api key=SECRET` redacted `foo api` and left the mangled
    // remainder `key=SECRET` — a name no rule recognizes — readable. The
    // value ends before the complete name, which its own rule then redacts.
    const scrubbed = scrubTelemetryString("password=foo api key=SECRET");

    assert.equal(scrubbed, "password=[REDACTED] api key=[REDACTED]");

    const secretKey = scrubTelemetryString("password=foo secret key=SECRET");

    assert.equal(secretKey, "password=[REDACTED] secret key=[REDACTED]");

    const privateKey = scrubTelemetryString("password=foo private key=KEYVAL");

    assert.equal(privateKey, "password=[REDACTED] private key=[REDACTED]");

    const walletPassphrase = scrubTelemetryString("password=foo wallet passphrase=words here");

    assert.equal(walletPassphrase, "password=[REDACTED] wallet passphrase=[REDACTED]");

    const insideMnemonic = scrubTelemetryString("seed=alpha bravo api key=SECRET status=502");

    assert.equal(insideMnemonic, "seed=[REDACTED] api key=[REDACTED] status=502");
  });

  it("ends a space-separated assignment value at structure", () => {
    const scrubbed = scrubTelemetryString(
      "Import failed (walletPassphrase=correct horse battery staple, retrying)"
    );

    assert.ok(!scrubbed.includes("horse"));
    assert.ok(!scrubbed.includes("staple"));
    assert.ok(scrubbed.includes(", retrying)"));
  });

  it("keeps punctuation that continues a value inside the redaction", () => {
    // The value must not stop where the generic rule's punctuation stopped:
    // `password=alpha;bravo` used to redact whole, and the word-list form
    // reintroducing `;`, `)` and `]` as boundaries would leave those tails
    // readable for a value that contains them.
    for (const tail of [";", ")", "]", '"']) {
      const scrubbed = scrubTelemetryString(`password=alpha${tail}bravo baz`);

      assert.ok(!scrubbed.includes("alpha"), tail);
      assert.ok(!scrubbed.includes("bravo"), tail);
    }

    const semicolonPair = scrubTelemetryString("seed=not-a-real-seed; token=not-a-real-token");

    assert.equal(semicolonPair, "seed=[REDACTED] token=[REDACTED]");
  });

  it("keeps seed exact-only in serialized fields and assignments", () => {
    const body =
      '{"pda_seed":"public-derivation","pda-seed":"public-derivation","seeds":["owner","aux"]}';
    const assignment = "pda_seed=public-derivation; pda-seed=public-derivation";

    assert.equal(scrubTelemetryString(body), body);
    assert.equal(scrubTelemetryString(assignment), assignment);
    assert.equal(scrubTelemetryString('{"seed":"recovery phrase"}'), '{"seed":"[REDACTED]"}');
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

describe("redactCredentialString: credentials encoded inside strings", () => {
  const mnemonic = "alpha bravo charlie delta echo foxtrot golf hotel";

  it("redacts a serialized mnemonic field in a provider error body", () => {
    const body = JSON.stringify({ error: "invalid", wallet: { mnemonic, chainType: "solana" } });

    const redacted = redactCredentialString(`Privy request failed: ${body}`);

    assert.ok(!redacted.includes("alpha bravo"), redacted);
    assert.ok(redacted.includes('"chainType":"solana"'), redacted);
  });

  it("redacts a mnemonic in a body that is itself a JSON document, at any nesting", () => {
    const nested = JSON.stringify({ response: JSON.stringify({ walletMnemonic: mnemonic }) });

    const redacted = redactCredentialString(nested);

    assert.ok(!redacted.includes("alpha bravo"), redacted);
    assert.deepEqual(JSON.parse(JSON.parse(redacted).response), { walletMnemonic: "[REDACTED]" });
  });

  it("redacts a mnemonic assignment under any credential name, not only the bare word", () => {
    for (const key of ["mnemonic", "walletMnemonic", "wallet_mnemonic", "seed phrase"]) {
      const redacted = redactCredentialString(`import failed: ${key}=${mnemonic}, status=400`);

      assert.equal(redacted, `import failed: ${key}=[REDACTED], status=400`);
    }
  });

  it("redacts key material whose value is not a string", () => {
    const redacted = redactCredentialString(
      'upstream said {"secretKey":[12,34,56],"pin":"x","ok":true}'
    );

    assert.equal(redacted, 'upstream said {"secretKey":[REDACTED],"pin":"x","ok":true}');
    assert.equal(
      redactCredentialString('{"secretKey":[12,34,56],"walletId":"wal_1"}'),
      '{"secretKey":"[REDACTED]","walletId":"wal_1"}'
    );
  });

  it("strips URL userinfo from a string and from a URL object", () => {
    assert.equal(
      redactCredentialString(
        `GET ${credentialUrl("https", "svc-user", "rpc.example.test/v1")} failed`
      ),
      "GET https://[REDACTED]@rpc.example.test/v1 failed"
    );
    assert.equal(
      redactCredentialString(
        `connect ${credentialUrl("postgres", "app", "db.internal:5432/sdp")} refused`
      ),
      "connect postgres://[REDACTED]@db.internal:5432/sdp refused"
    );

    const url = new URL(credentialUrl("https", "svc-user", "rpc.example.test/v1?cluster=devnet"));

    assert.equal(
      scrubTelemetry({ url }).url,
      "https://[REDACTED]@rpc.example.test/v1?cluster=devnet"
    );
    assert.equal(
      redactCredentialSecrets({ url }).url,
      "https://[REDACTED]@rpc.example.test/v1?cluster=devnet"
    );
    assert.ok(
      !JSON.stringify(scrubTelemetry({ body: JSON.stringify({ url }) })).includes(FAKE_PASSWORD)
    );
  });

  it("decodes percent-encoded credentials before matching", () => {
    const encoded = encodeURIComponent(
      JSON.stringify({ mnemonic, appSecret: "not-a-real-app-secret" })
    );

    const redacted = redactCredentialString(`callback?state=${encoded}`);

    assert.ok(!redacted.includes("alpha"), redacted);
    assert.ok(!redacted.includes("not-a-real-app-secret"), redacted);
    assert.ok(
      !redactCredentialString(
        `url=${encodeURIComponent(credentialUrl("https", "u", "h.test/"))}`
      ).includes(FAKE_PASSWORD)
    );
    assert.ok(
      !redactCredentialString(
        `next=${encodeURIComponent(encodeURIComponent("token=not-a-real-token"))}`
      ).includes("not-a-real-token")
    );
  });

  it("redacts a percent-encoded credential in a signer error's context", () => {
    const error = Object.assign(new Error("Remote API error"), {
      context: {
        status: 400,
        response: `{"error":"bad request","echo":"${encodeURIComponent(`"privateKey":"not-a-real-key-material"`)}"}`,
      },
    });

    // `context` is an own enumerable property of the scrubbed error, so it
    // serializes; `message` and `stack` do not.
    const serialized = JSON.stringify(scrubError(error));

    assert.ok(!serialized.includes("not-a-real-key-material"), serialized);
    assert.ok(serialized.includes('"status":400'), serialized);
  });

  it("does not end a bracketed value at a bracket inside one of its strings", () => {
    for (const body of [
      'upstream said {"credentials":{"value":"pa}ss"}}, retrying',
      'upstream said {\\"credentials\\":{\\"value\\":\\"pa}ss\\"}}, retrying',
    ]) {
      const redacted = redactCredentialString(body);

      assert.ok(!redacted.includes("ss"), redacted);
    }
    assert.equal(
      redactCredentialString('upstream said {"credentials":{"value":"pa]ss"}} ok'),
      'upstream said {"credentials":[REDACTED]} ok'
    );
  });

  it("strips userinfo that contains an apostrophe", () => {
    assert.equal(
      redactCredentialString(
        `GET ${credentialUrl("https", "svc", "rpc.example.test/v1", "not-a'real-pass")} failed`
      ),
      "GET https://[REDACTED]@rpc.example.test/v1 failed"
    );
  });

  it("redacts a credential written into a JSON property name", () => {
    const redacted = redactCredentialString(
      '{"token=not-a-real-token":"denied","walletId":"wal_1"}'
    );

    assert.ok(!redacted.includes("not-a-real-token"), redacted);
    assert.ok(redacted.includes('"walletId":"wal_1"'), redacted);
  });

  it("keeps an own __proto__ field when a sibling is redacted", () => {
    const redacted = redactCredentialString('{"__proto__":{"note":"kept"},"password":"fake"}');

    assert.equal(redacted, '{"__proto__":{"note":"kept"},"password":"[REDACTED]"}');
  });

  it("keeps ordinary fields and already-encoded text that hides nothing", () => {
    const body = `{"walletId":"wal_1","mint":"${SOLANA_ADDRESS}","tokenName":"USD Coin","seeds":["owner"]}`;
    const query =
      "https://dash.example.test/cb?redirect_url=https%3A%2F%2Fdash.example.test%2Fhome";

    assert.equal(redactCredentialString(body), body);
    assert.equal(redactCredentialString(query), query);
    assert.equal(
      redactCredentialString("status: 502, code=upstream_error"),
      "status: 502, code=upstream_error"
    );
    assert.equal(
      redactCredentialString("see https://docs.example.test/errors"),
      "see https://docs.example.test/errors"
    );
  });

  it("redacts a quoted credential key of any length", () => {
    const key = `${"x-".repeat(65)}api-key`;

    const redacted = redactCredentialString(`upstream said {"${key}":"not-a-real-key"}`);

    assert.equal(redacted, `upstream said {"${key}":"[REDACTED]"}`);
  });

  it("keeps the text of numbers JSON.parse would round", () => {
    for (const amount of ["12345678901234567890", "1.2345678901234567e+30"]) {
      assert.equal(
        redactCredentialString(`{"password":"not-a-real-pass","amount":${amount}}`),
        `{"password":"[REDACTED]","amount":${amount}}`
      );
    }
  });

  it("redacts an escaped credential key in a document with a long number", () => {
    const redacted = redactCredentialString(
      '{"requestId":"1234567890123456","\\u006dnemonic":"alpha bravo"}'
    );

    assert.ok(!redacted.includes("alpha bravo"), redacted);
    assert.ok(redacted.includes("1234567890123456"), redacted);
  });

  it("masks a value that only starts with the redaction marker", () => {
    assert.equal(
      redactCredentialString("password=[REDACTED]correct horse battery staple"),
      "password=[REDACTED]"
    );
    assert.equal(redactCredentialString("token=[REDACTED]not-a-real-token"), "token=[REDACTED]");
    assert.equal(
      redactCredentialString("__clerk_ticket=[REDACTED]not-a-real-ticket&x=1"),
      "__clerk_ticket=[REDACTED]&x=1"
    );
    assert.equal(
      redactCredentialString("token=[REDACTED], status=502"),
      "token=[REDACTED], status=502"
    );
    assert.equal(
      redactCredentialString('upstream said {"message":"Cookie: session=abc","status":502}'),
      'upstream said {"message":"Cookie: [REDACTED]","status":502}'
    );
  });

  it("masks to the end rather than guess where a malformed value ends", () => {
    assert.equal(redactCredentialString('{"mnemonic":"alpha bravo'), '{"mnemonic":"[REDACTED]');
    assert.equal(redactCredentialString('{"secretKey":[12,34'), '{"secretKey":[REDACTED]');
  });

  it("stays linear on long encoded and nested input", () => {
    const payloads = [
      "%".repeat(200_000),
      "%41".repeat(100_000),
      `${"https://".repeat(20_000)}x`,
      `${"a.".repeat(100_000)}`,
      `${"word ".repeat(40_000)}`,
      JSON.stringify(Array.from({ length: 2_000 }, (_, i) => ({ id: i, note: "x".repeat(20) }))),
    ];

    for (const payload of payloads) {
      const startedAt = process.hrtime.bigint();
      redactCredentialString(payload);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      assert.ok(elapsedMs < 1_000, `expected a linear scan, took ${elapsedMs.toFixed(0)}ms`);
    }
  });
});
