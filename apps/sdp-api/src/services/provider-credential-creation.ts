import type { Context } from "hono";
import { getDb } from "@/db";
import { conflict, providerUnavailable } from "@/lib/errors";
import { describeError, logEvent } from "@/runtime/money-path-events";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";
import {
  type ProviderCredentialRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import { ProviderCredentialSecretCleanupStore } from "@/services/stores/provider-credential-secret-cleanup.store";
import type { Env } from "@/types/env";

/** A reserved write is not a successful submission and must never be replayed as one. */
export function assertCredentialCreationSettled(credential: ProviderCredentialRow): void {
  if (credential.status === "creating") {
    throw providerUnavailable("Credential creation has not completed; retry the same request");
  }
  if (
    credential.status === "deactivated" &&
    credential.last_failure_code === "secret_creation_abandoned"
  ) {
    throw conflict("Credential creation was cancelled; start a new attempt");
  }
}

/**
 * The conditional UPDATE waits for any uncertain finalization COMMIT and cannot
 * cancel an adopted secret. No external destroy is safe merely because a read failed.
 * If this write fails too, the persisted creating row remains recoverable by cleanup.
 */
export async function recoverCredentialCreation(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  credentialId: string,
  written?: StoredCredentialSecret
): Promise<
  | { kind: "adopted"; credential: ProviderCredentialRow }
  | { kind: "abandoned" }
  | { kind: "unknown" }
> {
  try {
    return await getDb(c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      const credential = await store.findCredential(credentialId, { lock: true });
      if (!credential || credential.organization_id !== organizationId) {
        return { kind: "unknown" as const };
      }
      if (
        credential.status === "creating" ||
        credential.last_failure_code === "secret_creation_abandoned"
      ) {
        if (credential.status === "creating") {
          if (!(await store.abandonCredentialCreation({ organizationId, credentialId }))) {
            throw new Error("Credential creation could not be cancelled under its lock");
          }
        }
        if (
          written?.storageBackend === "gcp_secret_manager" &&
          written.secretRef &&
          written.secretVersionRef
        ) {
          await new ProviderCredentialSecretCleanupStore(tx).recordAcknowledgedGcpVersion({
            id: credentialId,
            secretRef: written.secretRef,
            secretVersionRef: written.secretVersionRef,
          });
        }
        return { kind: "abandoned" as const };
      }
      return { kind: "adopted" as const, credential };
    });
  } catch (error) {
    logEvent("error", {
      event: "sdp_api_credential_creation_failure",
      stage: "abandon",
      organization_id: organizationId,
      provider_credential_id: credentialId,
      request_id: c.get("requestId"),
      ...describeError(error),
    });
    return { kind: "unknown" };
  }
}
