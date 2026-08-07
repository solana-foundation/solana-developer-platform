import { describe, expect, it } from "vitest";
import { privateChannelTransferAmountSchema } from "@/lib/private-channel-transfer-amount";
import { createOpenApiDocument } from "./spec";

function parameterNamed(
  parameters: Array<Record<string, unknown> | { $ref: string }> | undefined,
  name: string
) {
  return parameters?.find((parameter) => "name" in parameter && parameter.name === name) as
    | Record<string, unknown>
    | undefined;
}

describe("Private Channel transfer OpenAPI", () => {
  it("registers all transfer paths and operations", () => {
    const document = createOpenApiDocument();

    expect(
      document.paths?.["/v1/private-channels/channels/{channelId}/transfer-recipients"]?.get
        ?.operationId
    ).toBe("listPrivateChannelTransferRecipients");
    expect(
      document.paths?.["/v1/private-channels/channels/{channelId}/transfers"]?.post?.operationId
    ).toBe("createPrivateChannelTransfer");
    expect(document.paths?.["/v1/private-channels/transfers"]?.get?.operationId).toBe(
      "listPrivateChannelTransfers"
    );
    expect(document.paths?.["/v1/private-channels/transfers/{id}"]?.get?.operationId).toBe(
      "getPrivateChannelTransfer"
    );
  });

  it("documents the opaque recipient request without an idempotency header", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/v1/private-channels/channels/{channelId}/transfers"]?.post;
    const idempotencyKey = parameterNamed(
      operation?.parameters as Array<Record<string, unknown> | { $ref: string }> | undefined,
      "Idempotency-Key"
    );
    const serializedBody = JSON.stringify(operation?.requestBody);

    expect(idempotencyKey).toBeUndefined();
    expect(serializedBody).toContain('"walletId"');
    expect(serializedBody).toContain('"recipientVerifiedWalletId"');
    expect(serializedBody).toContain('"amount"');
    expect(serializedBody).not.toContain('"recipientAddress"');
  });

  it("accepts only positive amounts within the mint's six decimals", () => {
    for (const invalid of ["not-a-decimal", "0", "1.0000001"]) {
      expect(privateChannelTransferAmountSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    for (const valid of [".5", "1", "1.000001"]) {
      expect(privateChannelTransferAmountSchema.safeParse(valid).success, valid).toBe(true);
    }
  });

  it("documents session-only access for recipient discovery and transfer creation", () => {
    const document = createOpenApiDocument();
    const recipients =
      document.paths?.["/v1/private-channels/channels/{channelId}/transfer-recipients"]?.get;
    const create = document.paths?.["/v1/private-channels/channels/{channelId}/transfers"]?.post;
    const recipientProject = parameterNamed(
      recipients?.parameters as Array<Record<string, unknown> | { $ref: string }> | undefined,
      "x-project-id"
    );
    const createProject = parameterNamed(
      create?.parameters as Array<Record<string, unknown> | { $ref: string }> | undefined,
      "x-project-id"
    );

    expect(recipients?.security).toEqual([{ sessionCookie: [] }]);
    expect(create?.security).toEqual([{ sessionCookie: [] }]);
    expect(recipientProject).toMatchObject({ in: "header", required: true });
    expect(createProject).toMatchObject({ in: "header", required: true });
    expect(document.paths?.["/v1/private-channels/transfers"]?.get?.security).toEqual([
      { apiKeyAuth: [] },
    ]);
    expect(document.paths?.["/v1/private-channels/transfers/{id}"]?.get?.security).toEqual([
      { apiKeyAuth: [] },
    ]);
  });

  it("documents insufficient token balance for transfer creation", () => {
    const document = createOpenApiDocument();
    const create = document.paths?.["/v1/private-channels/channels/{channelId}/transfers"]?.post;

    expect(create?.responses?.["400"]).toBeDefined();
    expect(JSON.stringify(create?.responses?.["400"])).toContain('"INSUFFICIENT_TOKEN_BALANCE"');
  });

  it("documents recipient wallets, lifecycle statuses, and optional channel filtering", () => {
    const document = createOpenApiDocument();
    const recipients =
      document.paths?.["/v1/private-channels/channels/{channelId}/transfer-recipients"]?.get;
    const list = document.paths?.["/v1/private-channels/transfers"]?.get;
    const channelId = parameterNamed(
      list?.parameters as Array<Record<string, unknown> | { $ref: string }> | undefined,
      "channelId"
    );
    const serializedResponses = JSON.stringify({
      recipients: recipients?.responses?.["200"],
      list: list?.responses?.["200"],
    });

    expect(channelId).toMatchObject({
      in: "query",
      required: false,
    });
    for (const field of [
      "privateChannelUserId",
      "isSelf",
      "pubkey",
      "pending",
      "submitted",
      "confirmed",
      "failed",
    ]) {
      expect(serializedResponses).toContain(`"${field}"`);
    }
    // Transfers end at `confirmed`; only deposits and withdrawals reach `settled`.
    expect(serializedResponses).not.toContain('"settled"');
  });
});
