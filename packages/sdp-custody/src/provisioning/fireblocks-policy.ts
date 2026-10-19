import { SigningError } from "../signing";
import { assertHttpsBaseUrl, sha256Hex, sortJsonKeys } from "./common";
import { fireblocksRequest } from "./fireblocks-http";
import type { FireblocksTransferAccess } from "./fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "./runtime";

export type FireblocksPolicyRule = Record<string, unknown>;
export interface FireblocksPolicySnapshot {
  rules: FireblocksPolicyRule[];
  revision: string;
  valid: boolean;
}
export function policyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SigningError("Invalid Fireblocks policy response", "NETWORK_ERROR");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new SigningError("Invalid Fireblocks policy list", "NETWORK_ERROR");
  return value;
}
function config(access: FireblocksTransferAccess) {
  return {
    ...access,
    apiBaseUrl: assertHttpsBaseUrl(access.apiBaseUrl ?? "https://api.fireblocks.io", "Fireblocks"),
  };
}
export async function fireblocksPolicyRevision(
  runtime: CustodyProvisioningRuntime,
  value: unknown
) {
  return sha256Hex(runtime, JSON.stringify(sortJsonKeys(value)));
}
async function snapshot(
  runtime: CustodyProvisioningRuntime,
  value: unknown
): Promise<FireblocksPolicySnapshot> {
  const envelope = policyRecord(value);
  const policy = policyRecord(envelope.policy);
  const rules = list(policy.rules).map(policyRecord);
  const validation = policyRecord(envelope.validation);
  const check = policyRecord(validation.checkResult);
  return {
    rules,
    revision: await fireblocksPolicyRevision(runtime, { rules, metadata: policy.metadata }),
    // PolicyValidation.status is an unconstrained string in the provider schema.
    // The documented per-rule results and error count are authoritative.
    valid:
      check.errors === 0 &&
      list(check.results).every((value) => {
        const result = policyRecord(value);
        return result.status === "ok" && list(result.errors).length === 0;
      }) &&
      !["UNVALIDATED", "INVALID_CONFIGURATION", "UNHANDLED_ERROR"].includes(
        String(validation.status)
      ),
  };
}
// Share successful reads only. A denied policy read must never become an empty policy.
const cache = new Map<string, { expires: number; value: Promise<FireblocksPolicySnapshot> }>();
export async function readFireblocksPolicy(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  fresh = false
) {
  const credentials = config(access);
  const key = `${credentials.apiBaseUrl}:${credentials.apiKey}`;
  const cached = cache.get(key);
  if (!fresh && cached && cached.expires > runtime.now()) return cached.value;
  const value = fireblocksRequest(runtime, {
    ...credentials,
    method: "GET",
    // biome-ignore lint/security/noSecrets: Public API path, not a credential.
    uri: "/v1/policy/active_policy?policyType=TRANSFER",
  }).then((data) => snapshot(runtime, data));
  const entry = { expires: runtime.now() + 15000, value };
  if (cache.size >= 100) cache.delete(cache.keys().next().value as string);
  cache.set(key, entry);
  void value.then(
    (snapshot) => {
      if (!snapshot.valid && cache.get(key) === entry) cache.delete(key);
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    }
  );
  return value;
}
