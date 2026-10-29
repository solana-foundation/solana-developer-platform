import { describe, expect, it } from "vitest";
import { listApiCatalogOperations, toPlaygroundEndpoint } from "./catalog";
import type { ApiOperation, ApiSchema } from "./reference";

function schema(type: ApiSchema["type"], overrides: Partial<ApiSchema> = {}): ApiSchema {
  return {
    type,
    format: null,
    nullable: false,
    description: null,
    enum: null,
    constraints: [],
    properties: [],
    items: null,
    additionalProperties: null,
    variantMode: null,
    variants: [],
    ...overrides,
  };
}

const operation: ApiOperation = {
  operationId: "createTransfer",
  endpointId: "create-transfer",
  method: "POST",
  path: "/v1/wallets/{walletId}/transfers",
  module: "core",
  action: null,
  auth: "apiKey",
  takesIdempotencyKey: false,
  summary: "Create a transfer",
  group: null,
  description: null,
  deprecated: false,
  parameters: [
    {
      name: "walletId",
      in: "path",
      required: true,
      description: null,
      schema: schema("string"),
      sample: "wallet_123",
    },
    {
      name: "limit",
      in: "query",
      required: false,
      description: "Maximum results",
      schema: schema("integer", { default: 25 }),
      sample: 25,
    },
    {
      name: "active",
      in: "query",
      required: false,
      description: null,
      schema: schema("boolean", { default: true }),
      sample: true,
    },
    {
      name: "status",
      in: "query",
      required: false,
      description: null,
      schema: schema("string", { enum: ["pending", "confirmed"] }),
      sample: "pending",
    },
    {
      name: "X-Trace-Id",
      in: "header",
      required: false,
      description: null,
      schema: schema("string"),
      sample: "trace_123",
    },
  ],
  requestBody: {
    required: true,
    description: null,
    contentType: "application/json",
    schema: schema("object"),
  },
  request: { path: "/v1/wallets/wallet_123/transfers", body: { amount: 10 } },
  responses: [
    {
      status: "201",
      description: "Created",
      body: { kind: "json", schema: schema("object"), example: { id: "transfer_123" } },
    },
    {
      status: "400",
      description: "Bad request",
      body: { kind: "json", schema: schema("object"), example: { code: "BAD_REQUEST" } },
    },
  ],
};

describe("API catalog", () => {
  it("lists every family and operation in reference order", () => {
    const entries = listApiCatalogOperations({
      families: [
        { name: "Health", description: "", operations: [operation] },
        {
          name: "Projects",
          description: "",
          operations: [{ ...operation, operationId: "getProject" }],
        },
      ],
    });

    expect(entries.map(({ family, operation: entry }) => `${family}/${entry.operationId}`)).toEqual(
      ["Health/createTransfer", "Projects/getProject"]
    );
  });

  it("projects form defaults, types, query placeholders, body and the success response", () => {
    const endpoint = toPlaygroundEndpoint(operation);

    expect(endpoint.path).toBe(
      "/v1/wallets/{walletId}/transfers?limit={limit}&active={active}&status={status}"
    );
    expect(endpoint.pathFields).toEqual([
      {
        key: "walletId",
        label: "{walletId}",
        description: undefined,
        defaultValue: "wallet_123",
        required: true,
      },
      {
        key: "limit",
        label: "limit",
        description: "Maximum results",
        defaultValue: "25",
        required: false,
        valueType: "number",
      },
      {
        key: "active",
        label: "active",
        description: undefined,
        defaultValue: "true",
        required: false,
        kind: "select",
        options: [
          { label: "true", value: "true" },
          { label: "false", value: "false" },
        ],
        valueType: "boolean",
      },
      {
        key: "status",
        label: "status",
        description: undefined,
        defaultValue: undefined,
        required: false,
        kind: "select",
        options: [
          { label: "pending", value: "pending" },
          { label: "confirmed", value: "confirmed" },
        ],
      },
    ]);
    expect(endpoint.bodyFields).toEqual([
      {
        key: "$body",
        label: "JSON request body",
        description: "Generated from this operation's public OpenAPI request schema.",
        kind: "textarea",
        valueType: "json",
        defaultValue: '{\n  "amount": 10\n}',
        required: true,
      },
    ]);
    expect(endpoint.expectedResponse).toEqual({ id: "transfer_123" });
  });

  it("keeps no body or example for a bodyless success response", () => {
    const endpoint = toPlaygroundEndpoint({
      ...operation,
      requestBody: null,
      request: { path: operation.path, body: null },
      responses: [{ status: "204", description: "No content", body: { kind: "empty" } }],
    });

    expect(endpoint.bodyFields).toEqual([]);
    expect(endpoint.expectedResponse).toEqual({});
  });
});
