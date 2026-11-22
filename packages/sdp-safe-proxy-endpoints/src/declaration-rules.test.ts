import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { declarationProblems } from "./declaration-rules";
import { type AllowedEndpoint, endpoint } from "./endpoint";

const fields = { query: [], callers: ["api"], requestHeaders: [], status: "active" } as const;

function problemsOf(...endpoints: AllowedEndpoint[]): string[] {
  return declarationProblems({ acme: { hosts: ["api.acme.test"], authScheme: "acme", endpoints } });
}

const listItems = () =>
  endpoint({ ...fields, method: "GET", path: "/v1/items", parameters: {}, kind: "read" });

const signItems = (field: string, values: readonly [string, ...string[]]) =>
  endpoint({
    ...fields,
    method: "POST",
    path: "/v1/items",
    parameters: {},
    kind: "sign",
    body: { field, values },
  });

describe("declarationProblems", () => {
  it("reports two declarations that can match the same request", () => {
    assert.deepEqual(problemsOf(listItems(), listItems()), [
      "acme GET /v1/items and GET /v1/items can match the same request",
    ]);

    const count = endpoint({
      ...fields,
      method: "GET",
      path: "/v1/items/count",
      parameters: {},
      kind: "read",
    });
    const byToken = endpoint({
      ...fields,
      method: "GET",
      path: "/v1/items/{item}",
      parameters: { item: { format: "token" } },
      kind: "read",
    });
    const byDigits = endpoint({
      ...fields,
      method: "GET",
      path: "/v1/items/{item}",
      parameters: { item: { format: "digits" } },
      kind: "read",
    });
    assert.deepEqual(problemsOf(byToken, count), [
      "acme GET /v1/items/{item} and GET /v1/items/count can match the same request",
    ]);
    assert.deepEqual(problemsOf(byDigits, count), []);
  });

  it("separates declarations on one path only by disjoint values of the same body field", () => {
    assert.deepEqual(problemsOf(signItems("op", ["a"]), signItems("op", ["b", "c"])), []);

    const overlap = ["acme POST /v1/items and POST /v1/items can match the same request"];
    assert.deepEqual(problemsOf(signItems("op", ["a", "b"]), signItems("op", ["b"])), overlap);
    assert.deepEqual(problemsOf(signItems("op", ["a"]), signItems("action", ["b"])), overlap);
  });

  it("reports a request header named in mixed case", () => {
    const traced = endpoint({
      ...fields,
      method: "GET",
      path: "/v1/items",
      parameters: {},
      kind: "read",
      requestHeaders: ["X-Trace-Id"],
    });
    assert.deepEqual(problemsOf(traced), [
      "acme GET /v1/items names request header X-Trace-Id in mixed case",
    ]);
  });

  it("reports a paired read the provider does not declare", () => {
    const list = listItems();
    const create = endpoint({
      ...fields,
      method: "POST",
      path: "/v1/items",
      parameters: {},
      kind: "change",
      idempotency: { key: { in: "body", field: "id" }, dedupe: { lasts: "permanent" }, read: list },
    });
    assert.deepEqual(problemsOf(create), [
      "acme POST /v1/items pairs a read that acme does not declare",
    ]);
    assert.deepEqual(problemsOf(create, list), []);
  });
});
