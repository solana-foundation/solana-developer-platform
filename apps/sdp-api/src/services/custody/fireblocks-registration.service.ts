import { FireblocksApiError } from "@sdp/custody/provisioning/fireblocks-http";
import {
  type ByokCustodyProvider,
  isProviderCredentialCreationInProgress,
} from "@sdp/types/custody";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db/client";
import {
  type FireblocksCsrPublicRow,
  FireblocksCsrRepository,
} from "@/db/repositories/fireblocks-csr.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  badRequest,
  conflict,
  forbidden,
  internalError,
  notFound,
  providerUnavailable,
} from "@/lib/errors";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { AuditService } from "@/services/audit.service";
import {
  assertCustodyEncryptionScheme,
  createCustodyCipher,
} from "@/services/custody-cipher/cipher-router";
import {
  admitByokCustodySetup,
  refuseCustodySetup,
} from "@/services/provider-availability.service";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";
import {
  type ByokCredentialFields,
  credentialPayload,
  fireblocksRegistrationSchema,
} from "./byok-credential";
import { generateFireblocksCsr } from "./fireblocks-csr";
import { listFireblocksVaults } from "./provisioning";

type AppContext = Context<{ Bindings: Env }>;
export interface FireblocksCsr {
  id: string;
  csrPem: string;
  expiresAt: string;
}
function publicCsr(row: FireblocksCsrPublicRow): FireblocksCsr {
  return { id: row.id, csrPem: row.csr_pem, expiresAt: row.expires_at };
}
export async function admitFireblocksRegistration(c: AppContext) {
  const auth = getAuth(c);
  if (!auth.userId || !c.get("clerk"))
    throw forbidden("Credential administration requires a signed-in user");
  const scope = { organizationId: auth.organizationId, projectId: requireProjectId(c) };
  const admission = await admitByokCustodySetup(c.env, getDb(c.env), scope, "fireblocks");
  if (!admission.admitted) throw refuseCustodySetup(admission);
  return { ...scope, userId: auth.userId };
}

/** Reloads public onboarding material only; this endpoint never decrypts a key. */
export async function getPendingFireblocksCsr(c: AppContext): Promise<FireblocksCsr | null> {
  const scope = await admitFireblocksRegistration(c);
  const row = await new FireblocksCsrRepository(getDb(c.env)).getPending(scope);
  return row ? publicCsr(row) : null;
}

/** Dedicated RSA-4096 key per setup attempt, scoped to one organization and project. */
export async function createFireblocksCsr(
  c: AppContext,
  idempotencyKey: string
): Promise<FireblocksCsr> {
  const scope = await admitFireblocksRegistration(c);
  assertCustodyEncryptionScheme(c.env);
  const db = getDb(c.env);
  const existing = await new FireblocksCsrRepository(db).getByIdempotencyKey(scope, idempotencyKey);
  if (existing) return publicCsr(existing);
  await enforceMeteredQuota(c, { name: "fireblocks-csr", actorMax: 3, orgMax: 10 });
  const id = `fbcsr_${crypto.randomUUID()}`;
  const audit = new AuditService(db);
  const intent = await audit.beginCritical(c, {
    organizationId: scope.organizationId,
    userId: scope.userId,
    action: "create",
    resourceType: "provider_credential",
    resourceId: id,
    metadata: { event: "fireblocks_csr_generation_started", projectId: scope.projectId },
  });
  const { csrPem, privateKeyPem } = await generateFireblocksCsr(id);
  const encrypted = await createCustodyCipher(c.env).encrypt(
    scope.organizationId,
    JSON.stringify({ id, projectId: scope.projectId, privateKeyPem })
  );
  const row = await db.transaction(async (tx) => {
    if (
      !(await new ProviderCredentialStore(tx).lockAuthorizedProjects(
        scope.organizationId,
        scope.userId,
        [scope.projectId]
      ))
    )
      throw forbidden("Requested project is not accessible");
    // Recheck after generation under the project lock to serialize concurrent retries.
    const csrs = new FireblocksCsrRepository(tx);
    const replay = await csrs.getByIdempotencyKey(scope, idempotencyKey);
    if (replay) return replay;
    if ((await csrs.countPending(scope)) >= 5)
      throw conflict("Finish an existing Fireblocks registration before generating another CSR");
    const inserted = await csrs.create(scope, {
      id,
      idempotencyKey,
      csrPem,
      encryptedKey: encrypted,
      userId: scope.userId,
    });
    if (!inserted) throw internalError();
    return inserted;
  });
  await audit.completeCritical(c, intent, {
    metadata: { event: "fireblocks_csr_generated", signingKeyId: row.id },
  });
  return publicCsr(row);
}

// Request-local deduplication avoids repeated key reads/decrypts during validation and storage.
const requestPayloads = new WeakMap<AppContext, Map<string, Promise<Record<string, string>>>>();
export async function resolveRegistrationPayload(
  c: AppContext,
  provider: ByokCustodyProvider,
  fields: ByokCredentialFields,
  idempotencyKey: string
): Promise<Record<string, string>> {
  if (provider === "privy") {
    if (!("appId" in fields)) throw badRequest("Invalid provider credential fields");
    return credentialPayload(provider, fields, c.get("projectEnvironment"));
  }
  const parsed = fireblocksRegistrationSchema.safeParse(fields);
  if (!parsed.success) throw badRequest("Use a generated Fireblocks CSR to register an API user");
  const input = parsed.data;
  // These are public identifiers, not a password. Store their canonical identity
  // directly: exact replay equality needs neither a password hash nor a digest.
  const fingerprint = JSON.stringify([
    c.req.path,
    idempotencyKey,
    input.signingKeyId,
    input.apiKey,
    input.vaultAccountId,
  ]);
  let cache = requestPayloads.get(c);
  if (!cache) {
    cache = new Map();
    requestPayloads.set(c, cache);
  }
  const cached = cache.get(fingerprint);
  if (cached) return cached;
  const payload = (async () => {
    const scope = await admitFireblocksRegistration(c);
    const row = await new FireblocksCsrRepository(getDb(c.env)).claimForRegistration(
      scope,
      input.signingKeyId,
      fingerprint
    );
    if (!row) throw notFound("Available Fireblocks CSR");
    const secret = JSON.parse(
      await createCustodyCipher(c.env).decrypt(scope.organizationId, row.encrypted_private_key)
    );
    if (
      secret.id !== row.id ||
      secret.projectId !== scope.projectId ||
      typeof secret.privateKeyPem !== "string"
    )
      throw internalError("Fireblocks registration key is unavailable");
    return credentialPayload(
      "fireblocks",
      {
        apiKey: input.apiKey,
        vaultAccountId: input.vaultAccountId,
        apiSecretPem: secret.privateKeyPem,
      },
      c.get("projectEnvironment")
    );
  })();
  cache.set(fingerprint, payload);
  return payload;
}

/** Erase the staging copy only after the credential lifecycle durably owns the key. */
export async function retireFireblocksCsr(
  c: AppContext,
  fields: ByokCredentialFields,
  credential: { id: string; status: import("@sdp/types/custody").ProviderCredentialStatus }
): Promise<void> {
  if (!("signingKeyId" in fields) || isProviderCredentialCreationInProgress(credential.status))
    return;
  const auth = getAuth(c);
  await new FireblocksCsrRepository(getDb(c.env)).retire(
    { organizationId: auth.organizationId, projectId: requireProjectId(c) },
    fields.signingKeyId,
    credential.id
  );
}

/** Called by the existing secret-retirement worker; bounded and idempotent. */
export async function eraseExpiredFireblocksCsrs(db: DatabaseClient): Promise<void> {
  await new FireblocksCsrRepository(db).eraseExpired();
}

/** Authenticated discovery uses only this project's unconsumed registration key. */
export async function discoverFireblocksVaults(
  c: AppContext,
  input: {
    signingKeyId: string;
    apiKey: string;
    after?: string;
    namePrefix?: string;
  }
) {
  const scope = await admitFireblocksRegistration(c);
  await enforceMeteredQuota(c, { name: "fireblocks-vault-discovery", actorMax: 30, orgMax: 100 });
  const row = await new FireblocksCsrRepository(getDb(c.env)).getForDiscovery(
    scope,
    input.signingKeyId
  );
  if (!row) throw notFound("Available Fireblocks CSR");
  const secret = JSON.parse(
    await createCustodyCipher(c.env).decrypt(scope.organizationId, row.encrypted_private_key)
  );
  if (
    secret.id !== row.id ||
    secret.projectId !== scope.projectId ||
    typeof secret.privateKeyPem !== "string"
  )
    throw internalError("Fireblocks registration key is unavailable");
  const environment = c.get("projectEnvironment");
  if (!environment) throw internalError("Project environment is required");
  try {
    return await listFireblocksVaults(
      c.env,
      {
        apiKey: input.apiKey,
        apiSecretPem: secret.privateKeyPem,
        assetId: environment === "production" ? "SOL" : "SOL_TEST",
      },
      { after: input.after, namePrefix: input.namePrefix }
    );
  } catch (error) {
    if (error instanceof FireblocksApiError && [401, 403].includes(error.status))
      throw badRequest(
        "Fireblocks could not authorize this API user. Confirm the CSR registration is approved, the API user ID is correct, and this server's IP is allowed."
      );
    throw providerUnavailable(
      "Could not load Fireblocks vaults. Check your workspace connection and try again."
    );
  }
}
