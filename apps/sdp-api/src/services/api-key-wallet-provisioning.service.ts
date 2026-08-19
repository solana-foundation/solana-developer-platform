import type { CustodyWalletPurpose } from "@sdp/types";
import type { DatabaseClient } from "@/db";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

export async function provisionApiKeyWallet(
  db: DatabaseClient,
  env: Env,
  params: {
    organizationId: string;
    projectId: string;
    legacyConfigProjectId?: string;
    connectionId?: string;
    label?: string;
    purpose?: CustodyWalletPurpose;
  }
): Promise<{ id: string; walletId: string }> {
  const targets = new CustodyRuntimeTargets(db, env, new Map());
  let connectionId = params.connectionId;
  if (!connectionId) {
    const target = await targets.resolve({
      kind: "effective",
      organizationId: params.organizationId,
      projectId: params.projectId,
    });
    if (target?.kind === "connection") {
      connectionId = target.connectionId;
    }
  }

  if (connectionId) {
    return targets.createConnectionWallet({
      organizationId: params.organizationId,
      projectId: params.projectId,
      connectionId,
      label: params.label,
      purpose: params.purpose,
    });
  }

  return createSigningService(env).createWallet(
    params.organizationId,
    params.legacyConfigProjectId,
    { label: params.label, purpose: params.purpose }
  );
}
