import { redactCredentialSecrets } from "@sdp/custody";
import {
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelInstanceEnvelope,
  type PrivateChannelInstanceResponse,
} from "@sdp/types";
import {
  mapPrivateChannelInstanceRow,
  type PrivateChannelInstanceRow,
  type PrivateChannelUserRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import {
  mapPrivateChannelError,
  provisionPrincipal,
  verifyInstanceConnection,
} from "@/services/private-channels";
import type { AppContext } from "../context";
import {
  getPrivateChannelDepositRepository,
  getPrivateChannelInstanceRepository,
  getPrivateChannelRepository,
  getPrivateChannelUserRepository,
  getPrivateChannelWithdrawalRepository,
  loadPrivateChannelProjectRpcClient,
} from "../context";
import { emitLifecycle, emitMember } from "../helpers";
import type { connectPrivateChannelInstanceSchema } from "../schemas";

export const getPrivateChannelInstance = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = getPrivateChannelInstanceRepository(c);
  const row = await repo.getActiveByProject({
    organizationId: auth.organizationId,
    projectId,
  });

  const response: PrivateChannelInstanceEnvelope = {
    instance: row ? mapPrivateChannelInstanceRow(row) : null,
  };
  return success(c, response);
};

export const connectPrivateChannelInstance = async (
  c: ValidatedBodyContext<typeof connectPrivateChannelInstanceSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const body = c.req.valid("json");
  const { confirmReactivate, ...input } = body;
  const projectRpc = await loadPrivateChannelProjectRpcClient(c);

  const repo = getPrivateChannelInstanceRepository(c);
  const scope = { organizationId: auth.organizationId, projectId };

  const active = await repo.getActiveByProject(scope);
  if (active) {
    // DB partial unique index is the real backstop against a racing double-Connect.
    throw new AppError(
      "CONFLICT",
      "This project already has an active Private Channel instance. Disconnect it before connecting a new one.",
      { activeInstance: mapPrivateChannelInstanceRow(active) }
    );
  }

  // Re-probe server-side: a tampered client could otherwise POST unreachable config.
  const probe = await verifyInstanceConnection({
    gatewayUrl: input.gatewayUrl,
    authUrl: input.authUrl,
    probeRpc: () =>
      projectRpc.probe({
        escrowProgramId: input.escrowProgramId,
        escrowInstanceAddr: input.escrowInstanceAddr,
      }),
  });
  if (!probe.ok) {
    // AppError responses are returned silently by app.onError; log diagnostics here.
    // The resolved RPC endpoint and credentials never reach logs or persistence.
    getLogger().warn(
      redactCredentialSecrets({
        organizationId: auth.organizationId,
        projectId,
        gatewayUrl: input.gatewayUrl,
        authUrl: input.authUrl,
        rpcProvider: projectRpc.target.providerId,
        gateway: probe.gateway,
        rpc: probe.rpc,
        auth: probe.auth,
      }),
      "connectPrivateChannelInstance: connection probe failed"
    );
    throw badRequest("Connection check failed", {
      gateway: probe.gateway,
      rpc: probe.rpc,
      auth: probe.auth,
    });
  }

  const existingByGateway = await repo.findByProjectAndGateway({
    ...scope,
    gatewayUrl: input.gatewayUrl,
  });

  let row: PrivateChannelInstanceRow | null;
  if (existingByGateway) {
    if (!confirmReactivate) {
      throw new AppError(
        "CONFLICT",
        "This gateway URL was previously connected to this project. Confirm to overwrite its config and reactivate.",
        {
          requiresReactivateConfirmation: true,
          existingInstance: mapPrivateChannelInstanceRow(existingByGateway),
        }
      );
    }
    row = await repo.reactivateAndUpdate({ id: existingByGateway.id, ...input });
  } else {
    row = await repo.createActive({
      ...scope,
      createdBy: auth.userId ?? null,
      ...input,
    });
  }

  if (!row) {
    throw badRequest("Failed to persist the private channel instance.");
  }

  // The default channel is bootstrapped exclusively here; GET /channels lists
  // what exists and does not lazy-create.
  const { channel: defaultChannel, created } = await getPrivateChannelRepository(
    c
  ).getOrCreateDefault({
    instanceId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  });
  // A connected instance is not usable without its project principal. Roll the
  // active connection back on registration failure so Connect can be retried.
  let defaultPrincipal: PrivateChannelUserRow | null = null;
  let defaultMembershipId: string | null = null;
  try {
    const userRepo = getPrivateChannelUserRepository(c);
    const { principal } = await provisionPrincipal(c.env, userRepo, {
      ...scope,
      instanceId: row.id,
      authUrl: row.auth_url,
      name: "Default",
      isDefault: true,
      createdBy: auth.userId ?? null,
    });
    defaultPrincipal = principal;
    const memberships = await userRepo.listMembershipsForUser(principal.id);
    const alreadyMember = memberships.some(
      (membership) => membership.channel_id === defaultChannel.id
    );
    const membership = await userRepo.addMembership({
      channelId: defaultChannel.id,
      privateChannelUserId: principal.id,
      addedBy: auth.userId ?? null,
    });
    if (!membership) {
      throw new Error("default Private Channels principal became inactive during setup");
    }
    if (!alreadyMember) defaultMembershipId = membership.id;
  } catch (error) {
    if (existingByGateway) await repo.deactivateActive(scope);
    else await repo.deleteActive(scope);
    throw mapPrivateChannelError(error);
  }

  await emitLifecycle(c, row, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED, {
    payload: { gatewayUrl: row.gateway_url },
  });
  if (created) {
    await emitLifecycle(c, row, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED, {
      channelId: defaultChannel.id,
      payload: { name: defaultChannel.name, isDefault: true },
    });
  }
  if (defaultPrincipal && defaultMembershipId) {
    await emitMember(
      c,
      { organizationId: row.organization_id, projectId: row.project_id, instanceId: row.id },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_ADDED,
      {
        channelId: defaultChannel.id,
        payload: { principalId: defaultPrincipal.id, membershipId: defaultMembershipId },
      }
    );
  }

  const response: PrivateChannelInstanceResponse = {
    instance: mapPrivateChannelInstanceRow(row),
  };
  return success(c, response);
};

export const disconnectPrivateChannelInstance = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = getPrivateChannelInstanceRepository(c);
  const row = await repo.deactivateActive({
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) {
    throw notFound("Active private channel instance");
  }

  await emitLifecycle(c, row, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_DISCONNECTED, {
    payload: { gatewayUrl: row.gateway_url },
  });

  const response: PrivateChannelInstanceResponse = {
    instance: mapPrivateChannelInstanceRow(row),
  };
  return success(c, response);
};

export const deletePrivateChannelInstance = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = getPrivateChannelInstanceRepository(c);
  const scope = { organizationId: auth.organizationId, projectId };
  const active = await repo.getActiveByProject(scope);
  if (!active) {
    throw notFound("Active private channel instance");
  }

  // Deposits and withdrawals are financial records that survive instance deletion,
  // but deleting an instance with IN-FLIGHT money movements would strand their
  // reconciliation. Reject it while any are non-terminal.
  //
  // TODO(disconnect-drain): this count->delete is check-then-act, so a deposit or
  // withdrawal created between the two still slips through and gets stranded. The
  // guard is worth having (it catches the common case) but it is not a barrier. The
  // real fix is a draining/read-only state on the instance: flip it first so no new
  // deposits or transfers are accepted, let the in-flight set settle, then allow the
  // delete — which also gives the operator a way to disconnect deliberately instead
  // of retrying against a moving target.
  const [depositsInFlight, withdrawalsInFlight] = await Promise.all([
    getPrivateChannelDepositRepository(c).countNonTerminalByInstance(active.id),
    getPrivateChannelWithdrawalRepository(c).countNonTerminalByInstance(active.id),
  ]);
  if (depositsInFlight > 0 || withdrawalsInFlight > 0) {
    throw new AppError(
      "CONFLICT",
      `Cannot delete this instance: ${depositsInFlight} deposit(s) and ${withdrawalsInFlight} withdrawal(s) are still in flight. Wait for them to settle or fail first.`
    );
  }

  await emitLifecycle(c, active, PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_DISCONNECTED, {
    payload: { gatewayUrl: active.gateway_url, reason: "deleted" },
  });

  const deleted = await repo.deleteActive(scope);
  if (!deleted) {
    throw notFound("Active private channel instance");
  }

  return success(c, { deleted: true });
};
