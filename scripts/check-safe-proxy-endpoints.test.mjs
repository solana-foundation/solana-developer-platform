import assert from "node:assert/strict";
import test from "node:test";
import { endpointCheckErrors, nonAdditiveChanges } from "./check-safe-proxy-endpoints.mjs";

const row = (kind, status = "active") => ({
  kind,
  status,
  callers: "api",
  query: "",
  requestHeaders: "",
  parameters: {},
});

const base = {
  fireblocks: {
    hosts: "api.fireblocks.io",
    endpoints: {
      "GET /v1/wallets": row("read"),
      "POST /v1/payments rail=card": row("sign"),
      "GET /v1/legacy": row("read", "retired"),
    },
  },
};

const edited = (from, edit) => {
  const head = structuredClone(from);
  edit(head);
  return head;
};
const withHead = (edit) => edited(base, edit);

test("refuses removing an endpoint the base still marks active", () => {
  const head = withHead(({ fireblocks }) => delete fireblocks.endpoints["GET /v1/wallets"]);

  assert.deepEqual(nonAdditiveChanges(base, head), [
    "fireblocks GET /v1/wallets was removed without being retired first.",
  ]);
});

test("refuses changing an endpoint's kind", () => {
  const head = withHead(({ fireblocks }) => {
    fireblocks.endpoints["POST /v1/payments rail=card"].kind = "change";
  });

  assert.deepEqual(nonAdditiveChanges(base, head), [
    "fireblocks POST /v1/payments rail=card changed kind from sign to change.",
  ]);
});

test("refuses removing a provider that still has active endpoints", () => {
  assert.deepEqual(nonAdditiveChanges(base, {}), [
    "fireblocks GET /v1/wallets was removed without being retired first.",
    "fireblocks POST /v1/payments rail=card was removed without being retired first.",
  ]);
});

const allowed = {
  "adds an endpoint": ({ fireblocks }) => {
    fireblocks.endpoints["GET /v1/vault/accounts"] = row("read");
  },
  "adds a body-value row": ({ fireblocks }) => {
    fireblocks.endpoints["POST /v1/payments rail=bank"] = row("sign");
  },
  "adds a provider": (head) => {
    head.privy = {
      hosts: "api.privy.io",
      endpoints: { "GET /v1/wallets": row("read") },
    };
  },
  "removes an endpoint the base marks retired": ({ fireblocks }) => {
    delete fireblocks.endpoints["GET /v1/legacy"];
  },
  "retires an active endpoint": ({ fireblocks }) => {
    fireblocks.endpoints["GET /v1/wallets"].status = "retired";
  },
  "widens an endpoint's callers": ({ fireblocks }) => {
    fireblocks.endpoints["GET /v1/wallets"].callers = "api cron";
  },
};

for (const [change, edit] of Object.entries(allowed)) {
  test(`allows a change that ${change}`, () => {
    assert.deepEqual(nonAdditiveChanges(base, withHead(edit)), []);
  });
}

const WIDE = "GET /v1/vault/accounts/{account}/{asset}";
const wide = withHead(({ fireblocks }) => {
  fireblocks.hosts = "api.fireblocks.io sandbox-api.fireblocks.io";
  fireblocks.endpoints[WIDE] = {
    ...row("read"),
    callers: "api cron",
    query: "after limit",
    requestHeaders: "idempotency-key",
    parameters: { account: "digits ^[0-9]{1,100}$", asset: "one_of SOL SOL_TEST" },
  };
});

const narrowing = {
  "drops a query name": [
    (endpoint) => {
      endpoint.query = "after";
    },
    "fireblocks GET /v1/vault/accounts/{account}/{asset} no longer allows query limit.",
  ],
  "drops a caller": [
    (endpoint) => {
      endpoint.callers = "api";
    },
    "fireblocks GET /v1/vault/accounts/{account}/{asset} no longer allows callers cron.",
  ],
  "drops a pass-through request header": [
    (endpoint) => {
      endpoint.requestHeaders = "";
    },
    "fireblocks GET /v1/vault/accounts/{account}/{asset} no longer allows requestHeaders idempotency-key.",
  ],
  "drops a one_of parameter value": [
    (endpoint) => {
      endpoint.parameters.asset = "one_of SOL";
    },
    "fireblocks GET /v1/vault/accounts/{account}/{asset} no longer allows asset SOL_TEST.",
  ],
  "changes a parameter's format": [
    (endpoint) => {
      endpoint.parameters.account = "digits ^[0-9]{1,20}$";
    },
    'fireblocks GET /v1/vault/accounts/{account}/{asset} changed parameter account from "digits ^[0-9]{1,100}$" to "digits ^[0-9]{1,20}$".',
  ],
};

for (const [change, [edit, error]] of Object.entries(narrowing)) {
  test(`refuses a change that ${change}`, () => {
    const head = edited(wide, ({ fireblocks }) => edit(fireblocks.endpoints[WIDE]));

    assert.deepEqual(nonAdditiveChanges(wide, head), [error]);
  });
}

test("refuses dropping a host the provider forwards to", () => {
  const head = edited(wide, ({ fireblocks }) => {
    fireblocks.hosts = "api.fireblocks.io";
  });

  assert.deepEqual(nonAdditiveChanges(wide, head), [
    "fireblocks no longer forwards to host sandbox-api.fireblocks.io.",
  ]);
});

test("allows adding query names, callers, request headers, one_of values and hosts", () => {
  const head = edited(wide, ({ fireblocks }) => {
    fireblocks.hosts = "api.fireblocks.io sandbox-api.fireblocks.io eu-api.fireblocks.io";
    Object.assign(fireblocks.endpoints[WIDE], {
      callers: "api cron worker",
      query: "after limit before",
      requestHeaders: "idempotency-key x-end-user-wallet-id",
    });
    fireblocks.endpoints[WIDE].parameters.asset = "one_of SOL SOL_TEST USDC";
  });

  assert.deepEqual(nonAdditiveChanges(wide, head), []);
});

test("allows narrowing an endpoint the base marks retired", () => {
  const retired = edited(wide, ({ fireblocks }) => {
    fireblocks.endpoints[WIDE].status = "retired";
  });
  const head = edited(retired, ({ fireblocks }) => {
    for (const [edit] of Object.values(narrowing)) edit(fireblocks.endpoints[WIDE]);
  });

  assert.deepEqual(nonAdditiveChanges(retired, head), []);
});

const clean = JSON.stringify(base);

test("reports a committed snapshot that differs from the rendered one as stale", () => {
  const rendered = JSON.stringify(
    withHead(({ fireblocks }) => {
      fireblocks.endpoints["GET /v1/wallets"].callers = "api cron";
    })
  );

  assert.deepEqual(
    endpointCheckErrors({ problems: [], rendered, committed: clean, base: undefined }),
    [
      "packages/sdp-safe-proxy-endpoints/endpoints.snapshot.json is stale. Run pnpm generate:safe-proxy-endpoints.",
    ]
  );
});

test("reports the declaration problems it is given", () => {
  const problems = ["fireblocks GET /v1/wallets declares no callers"];

  assert.deepEqual(
    endpointCheckErrors({ problems, rendered: clean, committed: clean, base: undefined }),
    ["fireblocks GET /v1/wallets declares no callers."]
  );
});

test("passes a clean snapshot when the merge-base has no snapshot yet", () => {
  assert.deepEqual(
    endpointCheckErrors({ problems: [], rendered: clean, committed: clean, base: undefined }),
    []
  );
});

test("reports a non-additive change of the rendered snapshot against the base", () => {
  const rendered = JSON.stringify(
    withHead(({ fireblocks }) => delete fireblocks.endpoints["GET /v1/wallets"])
  );

  assert.deepEqual(endpointCheckErrors({ problems: [], rendered, committed: rendered, base }), [
    "fireblocks GET /v1/wallets was removed without being retired first.",
  ]);
});
