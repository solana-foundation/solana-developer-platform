import { endpoint } from "./endpoint";

// `tsc --noEmit` covers this file: each @ts-expect-error fails the typecheck once
// endpoint() stops rejecting the declaration under it.

const fields = { query: [], callers: ["api"], requestHeaders: [], status: "active" } as const;

// A change declares where its idempotency key lives and the read that confirms it.
// @ts-expect-error
endpoint({ ...fields, method: "POST", path: "/v1/items", parameters: {}, kind: "change" });

endpoint({
  ...fields,
  method: "GET",
  path: "/v1/items/{item}",
  // @ts-expect-error every path parameter is declared in `parameters`
  parameters: {},
  kind: "read",
});
