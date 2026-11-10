import { runInClusterScope } from "@sdp/rpc/scope";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import { runAsMoneyPrincipal } from "@/lib/money-principal";
import { baseLoggerOptions, getLogContext, runWithLogContext } from "./logger";

function captureLogger() {
  const records: Record<string, unknown>[] = [];
  const logger = pino(baseLoggerOptions(), {
    write: (line: string) => records.push(JSON.parse(line)),
  });
  return { logger, records };
}

describe("logger context", () => {
  it("has no request context outside runWithLogContext", () => {
    expect(getLogContext()).toEqual({});
  });

  it("injects request_id and trace_id as first-class fields inside the context", () => {
    const { logger, records } = captureLogger();

    runWithLogContext({ request_id: "req_1", trace_id: "trace_1" }, () => {
      logger.info({ transfer_id: "tr_1" }, "transfer submitted");
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "req_1",
      trace_id: "trace_1",
      transfer_id: "tr_1",
      message: "transfer submitted",
    });
  });

  it("propagates context across awaited nested calls without threading params", async () => {
    const { logger, records } = captureLogger();

    async function nested() {
      await Promise.resolve();
      logger.error({ transfer_id: "tr_2" }, "transfer failed");
    }

    await runWithLogContext({ request_id: "req_2" }, () => nested());

    expect(records[0]).toMatchObject({ request_id: "req_2", transfer_id: "tr_2" });
    expect(records[0]).not.toHaveProperty("trace_id");
  });

  const inTenant = (log: () => void) =>
    runWithTenantDatabaseIdentity({ organizationId: "org_scope" }, log);
  const asMember = (log: () => void) =>
    runAsMoneyPrincipal({ kind: "member", userId: "usr_scope" }, log);

  it.each<[string, (log: () => void) => void, Record<string, string>]>([
    [
      "a member's tenant request on a project",
      (log) =>
        inTenant(() =>
          asMember(() =>
            runInClusterScope({ projectId: "prj_scope", environment: "production" }, log)
          )
        ),
      {
        organization_id: "org_scope",
        user_id: "usr_scope",
        project_id: "prj_scope",
        environment: "production",
      },
    ],
    [
      "an API key's tenant request",
      (log) => inTenant(() => runAsMoneyPrincipal({ kind: "api_key", apiKeyId: "key_scope" }, log)),
      { organization_id: "org_scope", api_key_id: "key_scope" },
    ],
    [
      "a cluster scope with no project",
      (log) => runInClusterScope({ projectId: null, environment: "sandbox" }, log),
      { environment: "sandbox" },
    ],
    [
      "a system job collecting a mandate",
      (log) =>
        runWithSystemDatabaseIdentity("job:scope", () =>
          runAsMoneyPrincipal({ kind: "mandate", recurringPaymentId: "rp_scope" }, log)
        ),
      {},
    ],
    ["no scope", (log) => log(), {}],
  ])("puts the identity of %s on the line", (_, scopes, identity) => {
    const { logger, records } = captureLogger();

    scopes(() => logger.info("scoped"));

    expect(records).toEqual([
      { level: 30, severity: "INFO", time: expect.any(Number), message: "scoped", ...identity },
    ]);
  });

  it("lets a field the line passes win over the same field from a scope", () => {
    const { logger, records } = captureLogger();

    inTenant(() => asMember(() => logger.info({ organization_id: "org_line" }, "created")));

    expect(records).toEqual([
      {
        level: 30,
        severity: "INFO",
        time: expect.any(Number),
        organization_id: "org_line",
        user_id: "usr_scope",
        message: "created",
      },
    ]);
  });

  it("keeps transfer_id queryable as a field, not embedded in the message", () => {
    const { logger, records } = captureLogger();

    runWithLogContext({ request_id: "req_3" }, () => {
      logger.info({ transfer_id: "tr_3" }, "settled");
    });

    expect(records[0].transfer_id).toBe("tr_3");
    expect(records[0].message).toBe("settled");
  });

  it("expands Error values under the error field", () => {
    const { logger, records } = captureLogger();

    logger.error({ error: new Error("boom") }, "failed");

    expect(records[0].error).toMatchObject({ type: "Error", message: "boom" });
  });

  it("does not leak fields into later records in the same request", () => {
    const { logger, records } = captureLogger();

    runWithLogContext({ request_id: "req_1" }, () => {
      logger.info({ transfer_id: "tr_1", error: "boom" }, "first");
      logger.info({ event: "request_completed" }, "second");
    });

    expect(records[1]).not.toHaveProperty("transfer_id");
    expect(records[1]).not.toHaveProperty("error");
  });

  it("emits a Cloud Logging severity alongside the numeric level", () => {
    const { logger, records } = captureLogger();

    logger.error("boom");

    expect(records[0]).toMatchObject({ level: 50, severity: "ERROR" });
  });
});

// The log sink's half of the PII policy. These go through a real pino instance
// on purpose: the scrubbing lives in the logger's own hook, so a test that
// mocked the logger would prove nothing about what reaches Cloud Logging.
describe("logger PII scrubbing", () => {
  it("redacts counterparty identity fields a caller passed by hand", () => {
    const { logger, records } = captureLogger();

    logger.info(
      {
        counterpartyId: "cp_1",
        email: "jane.doe@example.com",
        identity: { firstName: "Jane", dateOfBirth: "1988-04-02", phone: "+15551234567" },
        walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      },
      "counterparty created"
    );

    expect(records[0]).toMatchObject({
      counterpartyId: "cp_1",
      email: "[REDACTED]",
      identity: "[REDACTED]",
      // The Solana address is public on-chain and the handle for tracing the
      // payment; scrubbing it would blind the on-call engineer.
      walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    });
  });

  it("redacts an address that only appears inside the message", () => {
    const { logger, records } = captureLogger();

    logger.warn({ provider: "stripe" }, "rejected quote for jane.doe@example.com");

    expect(records[0].message).toBe("rejected quote for [REDACTED_EMAIL]");
    expect(records[0].provider).toBe("stripe");
  });

  it("redacts credentials that leaked into a provider error message", () => {
    const { logger, records } = captureLogger();

    logger.error({ error: new Error('Privy 401 {"appSecret":"privy-secret"}') }, "provider failed");

    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("privy-secret");
    // Still an Error to pino, so the `error` serializer shape is unchanged.
    expect(records[0].error).toMatchObject({ type: "Error" });
  });

  it("scrubs nested payloads without flattening the structure around them", () => {
    const { logger, records } = captureLogger();

    logger.info(
      { accounts: [{ accountNumber: "000123456789", accountKind: "bank_account" }] },
      "listed accounts"
    );

    expect(records[0].accounts).toEqual([
      { accountNumber: "[REDACTED]", accountKind: "bank_account" },
    ]);
  });
});
