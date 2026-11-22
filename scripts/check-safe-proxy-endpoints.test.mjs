import assert from "node:assert/strict";
import test from "node:test";
import { nonAdditiveChanges } from "./check-safe-proxy-endpoints.mjs";

const row = () => ({
  kind: "read",
  status: "active",
  callers: "api cron",
  query: "",
  requestHeaders: "",
  parameters: {},
});
const base = {
  fireblocks: { hosts: "api.fireblocks.io", endpoints: { "GET /v1/wallets": row() } },
};

const cases = [
  [
    "refuses removing an endpoint that is not retired",
    (endpoints) => delete endpoints["GET /v1/wallets"],
    ["fireblocks GET /v1/wallets was removed without being retired first."],
  ],
  [
    "refuses narrowing an endpoint",
    (endpoints) => {
      endpoints["GET /v1/wallets"].callers = "api";
    },
    ["fireblocks GET /v1/wallets no longer allows callers cron."],
  ],
  [
    "allows adding an endpoint",
    (endpoints) => {
      endpoints["GET /v1/vault/accounts"] = row();
    },
    [],
  ],
];

for (const [name, edit, errors] of cases) {
  test(name, () => {
    const head = structuredClone(base);
    edit(head.fireblocks.endpoints);
    assert.deepEqual(nonAdditiveChanges(base, head), errors);
  });
}
