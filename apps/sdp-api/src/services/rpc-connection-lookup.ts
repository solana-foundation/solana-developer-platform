import {
  type ByokRpcProvider,
  buildTenantRpcTarget,
  isByokRpcProvider,
  maskTenantEndpoint,
} from "@sdp/rpc/byok";
import type {
  RpcCredentialMode,
  TenantRpcConnectionLookup,
  TenantRpcConnectionResolution,
} from "@sdp/rpc/relay";
import type { RpcConnectionNetwork } from "@sdp/types";
import type { DatabaseExecutor } from "@/db";
import {
  type CredentialSecretStorageBackend,
  createCredentialSecretStore,
} from "@/services/credential-secret-store";
import { RpcConnectionStore } from "@/services/stores/rpc-connection.store";
import type { Env } from "@/types/env";

function isRpcConnectionNetwork(value: string): value is RpcConnectionNetwork {
  return value === "devnet" || value === "mainnet-beta";
}

/**
 * Supplies the relay with tenant connections (HOO-1093).
 *
 * This is the seam that keeps `@sdp/rpc` free of the secret store: the package
 * declares the port, and the resolved value it receives is already a built
 * target with a masked label. Secrets are read per request and never cached,
 * so a rotation takes effect on the next call without anything to invalidate.
 */
export function createTenantRpcConnectionLookup(
  env: Env,
  db: DatabaseExecutor
): TenantRpcConnectionLookup {
  const store = new RpcConnectionStore(db);

  return {
    async credentialMode(organizationId): Promise<RpcCredentialMode> {
      // Unknown organization reads as `managed`: this decides whether to fail
      // a request closed, and a missing row is not evidence that somebody
      // asked to be on their own keys.
      const row = await db.queryOne<{ rpc_credential_mode: string }>(
        `SELECT rpc_credential_mode FROM organizations WHERE id = ?`,
        [organizationId]
      );
      return row?.rpc_credential_mode === "byok" ? "byok" : "managed";
    },

    async resolve({ organizationId, scopeKey, network }): Promise<TenantRpcConnectionResolution> {
      if (!isRpcConnectionNetwork(network)) {
        return { kind: "none" };
      }

      const effective = await store.findEffectiveConnection({
        organizationId,
        scopeKey,
        network,
      });

      if (!effective) {
        // Nothing live. Distinguish "never configured" from "configured but
        // broken": only the second may fail the request closed.
        const state = await store.findScopeConnectionState({ organizationId, scopeKey, network });
        return state.kind === "unusable"
          ? { kind: "unusable", reason: "no active default connection" }
          : { kind: "none" };
      }

      const { connection, credential } = effective;
      if (!isByokRpcProvider(connection.provider)) {
        return { kind: "unusable", reason: "unsupported provider" };
      }

      const secretStore = createCredentialSecretStore(
        env,
        credential.storage_backend as CredentialSecretStorageBackend
      );

      let payload: Record<string, unknown>;
      try {
        payload = await secretStore.read({
          orgId: organizationId,
          stored: {
            storageBackend: credential.storage_backend as CredentialSecretStorageBackend,
            secretRef: credential.secret_ref ?? undefined,
            secretVersionRef: credential.secret_version_ref ?? undefined,
            encryptedSecretPayload: credential.encrypted_secret_payload ?? undefined,
          },
        });
      } catch {
        // The reason is deliberately coarse: a secret-store error message can
        // name refs, and this string reaches the caller.
        return { kind: "unusable", reason: "credential unavailable" };
      }

      const apiKey = String(payload.apiKey ?? "");
      const endpointUrl = String(payload.endpointUrl ?? "");
      if (!apiKey || !endpointUrl) {
        return { kind: "unusable", reason: "credential incomplete" };
      }

      const target = buildTenantRpcTarget(connection.provider as ByokRpcProvider, {
        endpointUrl,
        apiKey,
      });

      return {
        kind: "active",
        connectionId: connection.id,
        providerId: connection.provider as ByokRpcProvider,
        endpoint: target.endpoint,
        // The platform's maskEndpoint only knows operator env keys, so the
        // tenant's own key is masked here before the label leaves this module.
        endpointLabel: maskTenantEndpoint(target.endpoint, apiKey),
        headers: target.headers,
      };
    },
  };
}
