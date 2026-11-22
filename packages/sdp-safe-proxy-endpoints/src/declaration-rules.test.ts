import assert from "node:assert/strict";
import { it } from "node:test";
import { declarationProblems } from "./declaration-rules";
import { endpoint } from "./endpoint";

const signItems = (values: readonly [string, ...string[]]) =>
  endpoint({
    query: [],
    callers: ["api"],
    requestHeaders: [],
    status: "active",
    method: "POST",
    path: "/v1/items",
    parameters: {},
    kind: "sign",
    body: { field: "op", values },
  });

it("reports declarations that can match the same request, not ones split by body values", () => {
  const problemsOf = (...endpoints: ReturnType<typeof signItems>[]) =>
    declarationProblems({ acme: { hosts: ["api.acme.test"], endpoints } });

  assert.deepEqual(problemsOf(signItems(["a", "b"]), signItems(["b"])), [
    "acme POST /v1/items and POST /v1/items can match the same request",
  ]);
  assert.deepEqual(problemsOf(signItems(["a"]), signItems(["b"])), []);
});
