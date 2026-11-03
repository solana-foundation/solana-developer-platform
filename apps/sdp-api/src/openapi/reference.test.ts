import { type ApiSchema, apiReferenceSchema } from "@sdp/api-catalog/reference";
import { buildSnippets, SNIPPET_LANGUAGES } from "@sdp/api-catalog/snippets";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { DEFAULT_SDP_API_URL } from "@sdp/types/site";
import type { OpenAPIObject, OperationObject } from "openapi3-ts/oas30";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, type ErrorCode, isErrorCode } from "@/lib/errors";
import { DOCS_GROUP } from "./paths/helpers";
import { buildApiReference, exampleErrorCode } from "./reference";
import { createPublicOpenApiDocument } from "./spec";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

/** Every operation the document carries, as `METHOD path`, with the statuses it documents. */
function documentOperations(document: OpenAPIObject): Map<string, string[]> {
  return new Map(
    Object.entries(document.paths).flatMap(([path, item]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = item[method];
        if (operation === undefined) return [];
        return [[`${method.toUpperCase()} ${path}`, Object.keys(operation.responses)] as const];
      })
    )
  );
}

const errorExampleSchema = z.object({
  error: z.object({ code: z.custom<ErrorCode>((value) => isErrorCode(value)) }),
});

/** A document with one operation, for the shapes the published documents do not exercise. */
function documentWith(operation: Record<string, unknown>): OpenAPIObject {
  return {
    openapi: "3.0.3",
    info: { title: "Test", version: "0" },
    tags: [{ name: "Health", description: "Health checks." }],
    paths: { "/health": { get: { tags: ["Health"], responses: {}, ...operation } } },
  };
}

describe("buildApiReference", () => {
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    describe(`on ${releaseChannel}`, () => {
      const document = createPublicOpenApiDocument({ releaseChannel });
      const reference = apiReferenceSchema.parse(buildApiReference(document));
      const operations = reference.families.flatMap((family) => family.operations);

      it("documents every operation in the channel's document once, under its first tag", () => {
        expect(
          operations.map((operation) => `${operation.method} ${operation.path}`).sort()
        ).toEqual([...documentOperations(document).keys()].sort());
        expect(reference.families.map((family) => family.name)).toEqual(
          (document.tags ?? []).map((tag) => tag.name)
        );
        expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(
          operations.length
        );
      });

      it("gives every documented status an answer, and every error the code its status raises", () => {
        const documented = documentOperations(document);
        for (const operation of operations) {
          const statuses = documented.get(`${operation.method} ${operation.path}`);
          if (statuses === undefined) throw new Error(`${operation.operationId} is not documented`);
          expect(operation.responses.map((response) => response.status).sort()).toEqual(
            statuses.sort()
          );
          for (const response of operation.responses) {
            // The readiness probe's 503 is its own body, not the error envelope.
            if (!/^[45]/.test(response.status) || operation.path === "/health/ready") continue;
            expect(response.body.kind).toBe("json");
            if (response.body.kind !== "json") continue;
            const { error } = errorExampleSchema.parse(response.body.example);
            expect(String(new AppError(error.code).statusCode)).toBe(response.status);
          }
        }
      });

      it("gives every JSON response its schema, naming each field its example shows", () => {
        for (const operation of operations) {
          for (const response of operation.responses) {
            if (response.body.kind !== "json") continue;
            const shown = Object.keys(z.record(z.string(), z.json()).parse(response.body.example));
            const { properties } = response.body.schema;
            expect(properties.map((property) => property.name)).toEqual(
              expect.arrayContaining(shown)
            );
            expect(shown).toEqual(
              expect.arrayContaining(
                properties.filter((property) => property.required).map((property) => property.name)
              )
            );
          }
        }
      });

      it("lists no error codes, since the document's list names held modules' too", () => {
        for (const operation of operations) {
          for (const response of operation.responses) {
            if (response.body.kind !== "json") continue;
            const error = response.body.schema.properties.find(({ name }) => name === "error");
            const code = error?.schema.properties.find(({ name }) => name === "code");
            expect(code?.schema.enum ?? null, `${operation.operationId} ${response.status}`).toBe(
              null
            );
          }
        }
      });

      it("writes three samples per operation, each key only where the route takes it", () => {
        for (const operation of operations) {
          const snippets = buildSnippets({
            method: operation.method,
            url: `${DEFAULT_SDP_API_URL}${operation.request.path}`,
            body: operation.request.body,
            auth: operation.auth,
            takesIdempotencyKey: operation.takesIdempotencyKey,
          });
          const declaresIdempotencyKey = operation.parameters.some(
            (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key"
          );
          expect(operation.takesIdempotencyKey).toBe(declaresIdempotencyKey);
          for (const language of SNIPPET_LANGUAGES) {
            expect(snippets[language]).toContain(operation.request.path.split("?")[0]);
            expect(snippets[language].includes("SDP_API_KEY")).toBe(operation.auth === "apiKey");
            expect(snippets[language].includes("Idempotency-Key")).toBe(declaresIdempotencyKey);
          }
          expect(operation.request.path).not.toMatch(/[{}]/);
          expect(operation.request.body === null).toBe(operation.requestBody === null);
        }
      });
    });
  }

  it("keys a write's samples by the header the route declares, not by its method", () => {
    const operations = buildApiReference(
      createPublicOpenApiDocument({ releaseChannel: "experimental" })
    ).families.flatMap((family) => family.operations);
    const takesKey = (operationId: string) =>
      operations.find((operation) => operation.operationId === operationId)?.takesIdempotencyKey;
    // POST /v1/issuance/tokens ignores the header: a retry under one key creates a second token.
    expect(takesKey("createToken")).toBe(false);
    expect(takesKey("createPaymentTransfer")).toBe(true);
  });

  it("names the route's action in its 403 example, as the API refuses it", () => {
    const reference = buildApiReference(createPublicOpenApiDocument({ releaseChannel: "stable" }));
    const createWallet = reference.families
      .flatMap((family) => family.operations)
      .find((operation) => operation.operationId === "createWallet");
    expect(createWallet?.action).toBe("wallets.manage");
    expect(createWallet?.responses.find((response) => response.status === "403")?.body).toEqual({
      kind: "json",
      schema: expect.any(Object),
      example: {
        error: {
          code: "INSUFFICIENT_PERMISSIONS",
          message: "Missing action: wallets.manage",
          details: { action: "wallets.manage" },
        },
        meta: { requestId: "req_example" },
      },
    });
  });

  it("shows a not-ready body for the readiness probe's 503", () => {
    const readiness = buildApiReference(createPublicOpenApiDocument({ releaseChannel: "stable" }))
      .families.flatMap((family) => family.operations)
      .find((operation) => operation.path === "/health/ready");
    const notReady = readiness?.responses.find((response) => response.status === "503")?.body;
    expect(notReady).toMatchObject({ kind: "json", example: { status: "not_ready" } });
  });

  it("titles variants by the value they pin, and keeps a `not` as the properties it excludes", () => {
    const operations = buildApiReference(
      createPublicOpenApiDocument({ releaseChannel: "stable" })
    ).families.flatMap((family) => family.operations);
    const initialize = operations.find((operation) => operation.path === "/v1/wallets/initialize");
    expect(initialize?.requestBody?.schema.variantMode).toBe("oneOf");
    expect(initialize?.requestBody?.schema.variants[0]?.title).toBe('provider: "local"');
    const createWallet = operations.find((operation) => operation.operationId === "createWallet");
    expect(createWallet?.requestBody?.schema.variants[0]?.schema.constraints).toEqual([
      { kind: "excludes", value: ["connectionId"] },
    ]);
  });

  it("titles a response's variants, nested ones too, and keeps the fields each requires", () => {
    const operations = buildApiReference(
      createPublicOpenApiDocument({ releaseChannel: "experimental" })
    ).families.flatMap((family) => family.operations);
    const responseField = (operationId: string, status: string, ...path: string[]) => {
      const body = operations
        .find((operation) => operation.operationId === operationId)
        ?.responses.find((response) => response.status === status)?.body;
      if (body?.kind !== "json") throw new Error(`${operationId} ${status} has no JSON body`);
      return path.reduce((schema: ApiSchema, name) => {
        const property = schema.properties.find((each) => each.name === name);
        if (property === undefined) throw new Error(`${operationId} ${status} has no ${name}`);
        return property.schema;
      }, body.schema);
    };
    const providers = responseField("getProjectProviderAvailability", "200", "data", "providers");
    expect(providers.items?.variantMode).toBe("oneOf");
    expect(providers.items?.variants[0]?.title).toBe('family: "custody"');
    // A family's entry is a oneOf of its own, which both its variants pin to that family.
    const compliance = providers.items?.variants.find(
      (variant) => variant.title === 'family: "compliance"'
    );
    expect(compliance?.schema.variants.map((variant) => variant.title)).toEqual([
      "available: true",
      "available: false",
    ]);
    const wallet = responseField("createWallet", "201", "data", "wallet");
    expect(wallet.variants.map((variant) => [variant.title, variant.schema.constraints])).toEqual([
      [
        "Owned by a Managed config.",
        [
          { kind: "includes", value: ["custodyConfigId"] },
          { kind: "excludes", value: ["custodyConnectionId"] },
        ],
      ],
      [
        "Owned by a Custody Connection.",
        [
          { kind: "includes", value: ["custodyConnectionId"] },
          { kind: "excludes", value: ["custodyConfigId"] },
        ],
      ],
    ]);
  });

  it("carries the null of a nullable union or enum as `nullable`", () => {
    const reference = buildApiReference(
      documentWith({
        operationId: "getHealth",
        summary: "Health",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    units: { anyOf: [{ type: "number" }, { type: "string" }, { nullable: true }] },
                    purpose: { type: "string", nullable: true, enum: ["root", null] },
                  },
                },
              },
            },
          },
        },
      })
    );
    const body = reference.families[0]?.operations[0]?.responses[0]?.body;
    if (body?.kind !== "json") throw new Error("getHealth has no JSON body");
    const [units, purpose] = body.schema.properties.map((property) => property.schema);
    expect(units).toMatchObject({
      nullable: true,
      variants: [{ title: "number" }, { title: "string" }],
    });
    expect(purpose).toMatchObject({ nullable: true, enum: ["root"] });
  });

  it("fails the build on null in an enum that is not nullable", () => {
    expect(() =>
      buildApiReference(
        documentWith({
          operationId: "getHealth",
          summary: "Health",
          parameters: [{ name: "q", in: "query", schema: { type: "string", enum: ["a", null] } }],
        })
      )
    ).toThrow("null in an enum that is not nullable");
  });

  it("turns an OpenAPI 3.0 exclusive minimum into its own bound", () => {
    const reference = buildApiReference(
      documentWith({
        operationId: "getHealth",
        summary: "Health",
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 10 },
          },
        ],
      })
    );
    expect(reference.families[0]?.operations[0]?.parameters[0]?.schema.constraints).toEqual([
      { kind: "exclusiveMinimum", value: 0 },
      { kind: "maximum", value: 10 },
    ]);
  });

  it("fails the build on a schema keyword the reference cannot render", () => {
    expect(() =>
      buildApiReference(
        documentWith({
          operationId: "getHealth",
          summary: "Health",
          parameters: [{ name: "q", in: "query", schema: { type: "string", uniqueItems: true } }],
        })
      )
    ).toThrow("does not render `uniqueItems`");
  });

  it("fails the build on an operation with no operationId", () => {
    expect(() => buildApiReference(documentWith({ summary: "Health" }))).toThrow(
      "needs an operationId and a summary"
    );
  });

  it("carries each operation's docs group, and fails a family that groups only some", () => {
    const healthChecks = (live: string | undefined, ready: string | undefined): OpenAPIObject => {
      const operation = (operationId: string, group: string | undefined): OperationObject => {
        const built: OperationObject = {
          tags: ["Health"],
          operationId,
          summary: "Check",
          responses: { "200": { description: "OK" } },
        };
        if (group !== undefined) built[DOCS_GROUP] = group;
        return built;
      };
      return {
        openapi: "3.0.3",
        info: { title: "Test", version: "0" },
        tags: [{ name: "Health", description: "Health checks." }],
        paths: {
          "/health": { get: operation("live", live) },
          "/health/ready": { get: operation("ready", ready) },
        },
      };
    };
    const [family] = buildApiReference(healthChecks("Liveness", "Readiness")).families;
    expect(family?.operations.map((operation) => operation.group)).toEqual([
      "Liveness",
      "Readiness",
    ]);
    expect(() => buildApiReference(healthChecks("Liveness", undefined))).toThrow(
      `Health: 1 of 2 operations name a ${DOCS_GROUP}`
    );
    expect(() => buildApiReference(healthChecks("", ""))).toThrow(
      `${DOCS_GROUP} must name a group`
    );
  });
});

describe("exampleErrorCode", () => {
  it("picks, for each status, a code the API answers with that status", () => {
    for (const status of ["400", "401", "403", "404", "409", "422", "429", "500", "502", "503"]) {
      for (const takesIdempotencyKey of [true, false]) {
        const code = exampleErrorCode(status, takesIdempotencyKey, "test");
        expect(String(new AppError(code).statusCode)).toBe(status);
      }
    }
  });

  it("fails on a status it has no code for", () => {
    expect(() => exampleErrorCode("418", false, "GET /teapot")).toThrow(
      "GET /teapot documents a 418, which has no example error code"
    );
  });
});
