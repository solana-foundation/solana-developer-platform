import assert from "node:assert/strict";
import test from "node:test";
import { endpointCheckErrors, nonAdditiveChanges } from "./check-safe-proxy-endpoints.mjs";

const row = (kind, status = "active", callers = "api") => ({ kind, status, callers });

const base = {
  fireblocks: {
    endpoints: {
      "GET /v1/wallets": row("read"),
      "POST /v1/payments rail=card": row("sign"),
      "GET /v1/legacy": row("read", "retired"),
    },
  },
};

const withHead = (edit) => {
  const head = structuredClone(base);
  edit(head);
  return head;
};

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
    head.privy = { endpoints: { "GET /v1/wallets": row("read") } };
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
