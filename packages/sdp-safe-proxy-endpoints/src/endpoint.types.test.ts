import { endpoint } from "./endpoint";

// `tsc --noEmit` covers this file: each @ts-expect-error fails the typecheck once
// endpoint() stops rejecting the declaration under it.

const fields = { query: [], callers: ["api"], status: "active" } as const;

const read = endpoint({
  ...fields,
  method: "GET",
  path: "/v1/items/{item}",
  parameters: { item: { format: "token" } },
  kind: "read",
  requestHeaders: [],
});

const change = endpoint({
  ...fields,
  method: "POST",
  path: "/v1/items",
  parameters: {},
  kind: "change",
  requestHeaders: ["idempotency-key"],
  idempotency: {
    key: { in: "header", name: "idempotency-key" },
    dedupe: { lasts: "permanent" },
    read,
  },
});

// A change declares its idempotency.
// @ts-expect-error
endpoint({
  ...fields,
  method: "POST",
  path: "/v1/items",
  parameters: {},
  kind: "change",
  requestHeaders: [],
});

// Every path parameter has an entry in `parameters`.
endpoint({
  ...fields,
  method: "GET",
  path: "/v1/items/{item}",
  // @ts-expect-error
  parameters: {},
  kind: "read",
  requestHeaders: [],
});

// Every entry in `parameters` is named in the path.
endpoint({
  ...fields,
  method: "GET",
  path: "/v1/items",
  // @ts-expect-error
  parameters: { item: { format: "token" } },
  kind: "read",
  requestHeaders: [],
});
endpoint({
  ...fields,
  method: "GET",
  path: "/v1/items/{item}",
  // @ts-expect-error
  parameters: { item: { format: "token" }, other: { format: "digits" } },
  kind: "read",
  requestHeaders: [],
});

// A header idempotency key is one of the request headers.
endpoint({
  ...fields,
  method: "POST",
  path: "/v1/items",
  parameters: {},
  kind: "change",
  requestHeaders: ["idempotency-key"],
  idempotency: {
    // @ts-expect-error
    key: { in: "header", name: "other-key" },
    dedupe: { lasts: "permanent" },
    read,
  },
});

// The paired read is a read endpoint.
endpoint({
  ...fields,
  method: "POST",
  path: "/v1/items",
  parameters: {},
  kind: "change",
  requestHeaders: ["idempotency-key"],
  idempotency: {
    key: { in: "header", name: "idempotency-key" },
    dedupe: { lasts: "permanent" },
    // @ts-expect-error
    read: change,
  },
});
