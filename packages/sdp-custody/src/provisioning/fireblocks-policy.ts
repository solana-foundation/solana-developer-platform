import { SigningError } from "../signing";
import { assertHttpsBaseUrl, sha256Hex, sortJsonKeys } from "./common";
import { FireblocksApiError, fireblocksRequest } from "./fireblocks-http";
import type { FireblocksTransferAccess } from "./fireblocks-transfers";
import type { CustodyProvisioningRuntime } from "./runtime";

export type FireblocksPolicyRule = Record<string, unknown>;
export interface FireblocksPolicySnapshot {
  rules: FireblocksPolicyRule[];
  revision: string;
  draftId?: string;
  valid: boolean;
}
export interface FireblocksPolicyPerson {
  id: string;
  name: string;
  role: string;
  canSign: boolean;
}
export interface FireblocksPolicyGroup {
  id: string;
  name: string;
  memberIds: string[];
}
export interface FireblocksPolicyDirectory {
  initiator: { id: string; name: string };
  people: FireblocksPolicyPerson[];
  groups: FireblocksPolicyGroup[];
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
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500)
    throw new SigningError("Invalid Fireblocks policy field", "NETWORK_ERROR");
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
  value: unknown,
  draft: boolean
): Promise<FireblocksPolicySnapshot> {
  const envelope = policyRecord(value);
  const policy = policyRecord(envelope[draft ? "draftResponse" : "policy"]);
  const rules = list(policy.rules).map(policyRecord);
  const validation = policyRecord(envelope.validation);
  const check = policyRecord(validation.checkResult);
  return {
    rules,
    revision: await fireblocksPolicyRevision(runtime, { rules, metadata: policy.metadata }),
    ...(draft ? { draftId: text(policy.draftId) } : {}),
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
  }).then((data) => snapshot(runtime, data, false));
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
export async function readFireblocksPolicyDraft(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess
) {
  try {
    return await snapshot(
      runtime,
      await fireblocksRequest(runtime, {
        ...config(access),
        method: "GET",
        // biome-ignore lint/security/noSecrets: Public API path, not a credential.
        uri: "/v1/policy/draft?policyType=TRANSFER",
      }),
      true
    );
  } catch (error) {
    if (error instanceof FireblocksApiError && error.status === 404) return null;
    throw error;
  }
}
export async function readFireblocksPolicyDirectory(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess
): Promise<FireblocksPolicyDirectory> {
  const request = (uri: string) =>
    fireblocksRequest(runtime, { ...config(access), method: "GET", uri });
  const [consoleResult, apiResult, groupResult] = await Promise.all([
    request("/v1/management/users"),
    request("/v1/management/api_users"),
    request("/v1/management/user_groups"),
  ]);
  const apiUser = list(policyRecord(apiResult).users)
    .map(policyRecord)
    .find((user) => user.id === access.apiKey && user.enabled === true && user.userType === "API");
  if (!apiUser)
    throw new SigningError(
      "Cannot identify the connected Fireblocks API user",
      "PROVIDER_CREDENTIAL_INVALID"
    );
  const approvalRoles = new Set(["OWNER", "ADMIN", "NON_SIGNING_ADMIN", "SIGNER", "APPROVER"]);
  const signingRoles = new Set(["OWNER", "ADMIN", "SIGNER"]);
  const people = list(policyRecord(consoleResult).users)
    .map(policyRecord)
    .filter(
      (user) =>
        user.enabled === true &&
        user.status === "READY" &&
        user.userType === "CONSOLE" &&
        approvalRoles.has(String(user.role)) &&
        user.id !== apiUser.id
    )
    .map((user) => ({
      id: text(user.id),
      name:
        [user.firstName, user.lastName]
          .filter((s) => typeof s === "string")
          .join(" ")
          .trim() || text(user.email),
      role: text(user.role),
      canSign: signingRoles.has(String(user.role)),
    }));
  const groups = list(groupResult)
    .map(policyRecord)
    .filter((group) => group.status === "APPROVED")
    .map((group) => ({
      id: text(group.id),
      name: text(group.name),
      memberIds: list(group.memberIds).map(text),
    }));
  return { initiator: { id: text(apiUser.id), name: text(apiUser.name) }, people, groups };
}
export async function writeFireblocksPolicyDraft(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  rules: FireblocksPolicyRule[],
  key: string
) {
  return snapshot(
    runtime,
    await fireblocksRequest(runtime, {
      ...config(access),
      method: "PUT",
      uri: "/v1/policy/draft",
      body: { policyTypes: ["TRANSFER"], rules },
      idempotencyKey: key,
    }),
    true
  );
}
export async function publishFireblocksPolicyDraft(
  runtime: CustodyProvisioningRuntime,
  access: FireblocksTransferAccess,
  draftId: string,
  key: string
) {
  const result = policyRecord(
    await fireblocksRequest(runtime, {
      ...config(access),
      method: "POST",
      uri: "/v1/policy/draft",
      body: { policyTypes: ["TRANSFER"], draftId },
      idempotencyKey: key,
    })
  );
  const credentials = config(access);
  cache.delete(`${credentials.apiBaseUrl}:${credentials.apiKey}`);
  return text(result.status);
}
