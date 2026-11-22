import assert from "node:assert/strict";
import { it } from "node:test";
import { fireblocksAuthHeaders } from "./fireblocks";
import { privyAuthHeaders } from "./privy";
import { AUTH_INJECTIONS } from "./registry";

it("maps each auth scheme to its provider's injection", () => {
  assert.equal(AUTH_INJECTIONS.fireblocks_jwt, fireblocksAuthHeaders);
  assert.equal(AUTH_INJECTIONS.privy_basic, privyAuthHeaders);
});
