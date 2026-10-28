import { apiReferenceSchema } from "@sdp/api-catalog/reference";
import { buildSnippets, SNIPPET_LANGUAGES } from "@sdp/api-catalog/snippets";
import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { DEFAULT_SDP_API_URL } from "@sdp/types/site";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, type ErrorCode, isErrorCode } from "@/lib/errors";
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

      it("writes three samples per operation, with the key only where the route takes one", () => {
        for (const operation of operations) {
          const snippets = buildSnippets({
            method: operation.method,
            url: `${DEFAULT_SDP_API_URL}${operation.request.path}`,
            body: operation.request.body,
            auth: operation.auth,
          });
          for (const language of SNIPPET_LANGUAGES) {
            expect(snippets[language]).toContain(operation.request.path.split("?")[0]);
            expect(snippets[language].includes("SDP_API_KEY")).toBe(operation.auth === "apiKey");
          }
          expect(operation.request.path).not.toMatch(/[{}]/);
          expect(operation.request.body === null).toBe(operation.requestBody === null);
        }
      });
    });
  }

  it("names the route's action in its 403 example, as the API refuses it", () => {
    const reference = buildApiReference(createPublicOpenApiDocument({ releaseChannel: "stable" }));
    const createWallet = reference.families
      .flatMap((family) => family.operations)
      .find((operation) => operation.operationId === "createWallet");
    expect(createWallet?.action).toBe("wallets.manage");
    expect(createWallet?.responses.find((response) => response.status === "403")?.body).toEqual({
      kind: "json",
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
