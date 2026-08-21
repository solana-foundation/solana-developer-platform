import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sentryScrubbingHooks } from "./sentry";
import { assertScrubbed, COUNTERPARTY_PAYLOAD, SOLANA_ADDRESS } from "./test/fixtures";

describe("sentryScrubbingHooks", () => {
  it("scrubs an error event, including request, user, and breadcrumb data", () => {
    const event = {
      event_id: "evt_1",
      level: "error",
      exception: {
        values: [
          {
            type: "AppError",
            value: "counterparty jane.doe@example.com rejected",
            stacktrace: { frames: [{ filename: "handlers.ts", function: "createCounterparty" }] },
          },
        ],
      },
      user: { id: "user_1", email: "jane.doe@example.com", ip_address: "203.0.113.7" },
      request: {
        url: "https://api.example.com/v1/counterparties",
        query_string: "email=jane.doe%40example.com",
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
        cookies: "__session=abc123",
      },
      extra: COUNTERPARTY_PAYLOAD,
      breadcrumbs: [{ category: "fetch", data: { phone: "+15551234567" } }],
    };

    const scrubbed = sentryScrubbingHooks.beforeSend(event);
    const serialized = JSON.stringify(scrubbed);

    assertScrubbed(serialized);
    // The structure a Sentry issue is read through must survive intact.
    assert.equal(scrubbed?.event_id, "evt_1");
    assert.equal(scrubbed?.exception.values[0].type, "AppError");
    assert.equal(scrubbed?.exception.values[0].stacktrace.frames[0].filename, "handlers.ts");
    assert.equal(scrubbed?.user.id, "user_1");
    assert.equal(scrubbed?.user.email, "[REDACTED]");
    assert.equal(scrubbed?.user.ip_address, "[REDACTED]");
    assert.equal(scrubbed?.request.headers.authorization, "[REDACTED]");
    assert.equal(scrubbed?.request.cookies, "[REDACTED]");
    assert.ok(!serialized.includes("jane.doe"));
  });

  it("scrubs transactions, spans, logs, metrics, and breadcrumbs", () => {
    const attributes = {
      "counterparty.email": "jane.doe@example.com",
      "wallet.address": SOLANA_ADDRESS,
    };

    const transaction = sentryScrubbingHooks.beforeSendTransaction({
      transaction: "POST /v1/counterparties",
      contexts: { trace: { trace_id: "trace_1", data: attributes } },
    });
    const span = sentryScrubbingHooks.beforeSendSpan({
      span_id: "span_1",
      description: "quote for jane.doe@example.com",
      data: attributes,
    });
    const log = sentryScrubbingHooks.beforeSendLog({
      level: "info",
      body: "created counterparty jane.doe@example.com",
      attributes,
    });
    const metric = sentryScrubbingHooks.beforeSendMetric({
      name: "counterparty.created",
      value: 1,
      attributes,
    });
    const breadcrumb = sentryScrubbingHooks.beforeBreadcrumb({
      category: "ui.click",
      message: "submit for jane.doe@example.com",
    });

    for (const payload of [transaction, span, log, metric, breadcrumb]) {
      const serialized = JSON.stringify(payload);
      assert.ok(!serialized.includes("jane.doe@example.com"), serialized);
    }

    // Operational identity is untouched: the span still says what it was.
    assert.equal(span.span_id, "span_1");
    assert.equal(transaction?.transaction, "POST /v1/counterparties");
    assert.equal(transaction?.contexts.trace.trace_id, "trace_1");
    assert.equal(span.data["wallet.address"], SOLANA_ADDRESS);
    assert.equal(metric?.value, 1);
  });

  it("drops the payload when scrubbing throws, rather than sending it unscrubbed", () => {
    // A getter that throws stands in for any future shape the walker cannot
    // handle. Shipping the raw event would be the worse failure.
    const hostile = {
      get email(): string {
        throw new TypeError("no");
      },
    };

    assert.equal(sentryScrubbingHooks.beforeSend(hostile), null);
  });

  it("reduces a span to its skeleton when scrubbing throws, since a span must be returned", () => {
    const hostile = {
      span_id: "span_1",
      trace_id: "trace_1",
      op: "http.client",
      get data(): unknown {
        throw new TypeError("no");
      },
    };

    const span = sentryScrubbingHooks.beforeSendSpan(hostile);

    assert.deepEqual(span, {
      description: "[REDACTED]",
      span_id: "span_1",
      trace_id: "trace_1",
      op: "http.client",
    });
  });
});
