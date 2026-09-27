import { redactCredentialSecrets } from "@sdp/redaction";
import {
  PRIVATE_CHANNEL_EVENT_TYPES,
  type PrivateChannelInstanceEnvelope,
  type PrivateChannelInstanceResponse,
} from "@sdp/types";
import { asTransactionalClient, getDb } from "@/db";
import {
  createPostgresPrivateChannelDepositRepository,
  createPostgresPrivateChannelInstanceRepository,
  createPostgresPrivateChannelTransferRepository,
  createPostgresPrivateChannelWithdrawalRepository,
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
  assertApprovedPrivateChannelDestinations,
  mapPrivateChannelError,
  provisionPrincipal,
  toProbeResultDto,
  verifyInstanceConnection,
} from "@/services/private-channels";
import type { AppContext } from "../context";
import {
  getPrivateChannelDepositRepository,
  getPrivateChannelInstanceRepository,
  getPrivateChannelRepository,
  getPrivateChannelTransferRepository,
  getPrivateChannelUserRepository,
  getPrivateChannelWithdrawalRepository,
  loadPrivateChannelProjectRpcClient,
} from "../context";
import { emitLifecycle, emitMember } from "../helpers";
import type {
  connectPrivateChannelInstanceSchema,
  updatePrivateChannelInstanceSchema,
} from "../schemas";

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

  // Refuse an unapproved destination before probing it, so the operator gets a
  // field error naming the URL rather than a generic "unreachable" from a probe
  // that was never going to be allowed to leave.
  assertApprovedPrivateChannelDestinations(c.env, {
    gatewayUrl: input.gatewayUrl,
    authUrl: input.authUrl,
  });

  // Re-probe server-side: a tampered client could otherwise POST unreachable config.
  const probe = await verifyInstanceConnection(c.env, {
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
    // The resolved RPC endpoint and credentials never reach logs or persistence,
    // and the probe is logged in its bounded form so a gateway cannot write an
    // arbitrary payload into this deployment's logs by failing a health check.
    const summary = toProbeResultDto(probe);
    getLogger().warn(
      redactCredentialSecrets({
        organizationId: auth.organizationId,
        projectId,
        gatewayUrl: input.gatewayUrl,
        authUrl: input.authUrl,
        rpcProvider: projectRpc.target.providerId,
        gateway: summary.gateway,
        rpc: summary.rpc,
        auth: summary.auth,
      }),
      "connectPrivateChannelInstance: connection probe failed"
    );
    // The bounded DTO, not the engine result: this detail is echoed to the
    // client that nominated the gateway, and the engine result carries what
    // that gateway answered with.
    const { ok: _ok, ...detail } = summary;
    throw badRequest("Connection check failed", detail);
  }

  const existingByGateway = await repo.findByProjectAndGateway({
    ...scope,
    gatewayUrl: input.gatewayUrl,
  });

  let row: PrivateChannelInstanceRow | null;
  if (existingByGateway) {
    // Reactivating revives only this gateway's own instance, so it cannot
    // settle movements bound to a different one. Refuse while another
    // historical instance still has movements in flight (SOLA9-468): the
    // recovery path for those rows is reconnecting *their* gateway, and
    // handing this one the active slot again would strand them all the same.
    const [deposits, withdrawals, transfers] = await Promise.all([
      getPrivateChannelDepositRepository(c).countNonTerminalByProjectExcludingInstance(
        scope,
        existingByGateway.id
      ),
      getPrivateChannelWithdrawalRepository(c).countNonTerminalByProjectExcludingInstance(
        scope,
        existingByGateway.id
      ),
      getPrivateChannelTransferRepository(c).countNonTerminalByProjectExcludingInstance(
        scope,
        existingByGateway.id
      ),
    ]);
    if (deposits > 0 || withdrawals > 0 || transfers > 0) {
      throw new AppError(
        "CONFLICT",
        `This project has ${deposits} deposit(s), ${withdrawals} withdrawal(s), and ${transfers} transfer(s) still in flight on a different Private Channels instance. Reconnect that instance's gateway and let them settle or fail before reconnecting this one.`
      );
    }
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
    // A brand-new instance id is what strands history: replay authorizes a
    // movement against its own stored instance_id (see routes/private-channels/
    // replay.ts), so once a different gateway owns the project's single active
    // slot, an in-flight row bound to a retired instance can only be resolved
    // by reconnecting that gateway. Refuse the replacement while any historical
    // instance still has movements in flight (SOLA9-468). Reactivating a
    // gateway's own row skips this check — that reconnect is the recovery path
    // for its own rows; the reactivate branch above still refuses while a
    // different instance has rows in flight.
    const [deposits, withdrawals, transfers] = await Promise.all([
      getPrivateChannelDepositRepository(c).countNonTerminalByProject(scope),
      getPrivateChannelWithdrawalRepository(c).countNonTerminalByProject(scope),
      getPrivateChannelTransferRepository(c).countNonTerminalByProject(scope),
    ]);
    if (deposits > 0 || withdrawals > 0 || transfers > 0) {
      throw new AppError(
        "CONFLICT",
        `This project has ${deposits} deposit(s), ${withdrawals} withdrawal(s), and ${transfers} transfer(s) still in flight on a previous Private Channels instance. Reconnect that instance's gateway and let them settle or fail before connecting a different one.`
      );
    }
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
    // The instance this request just created, which no drain has touched.
    else await repo.deleteActive(scope, null);
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

/**
 * Reconfigure the active instance in place. The instance id is an optimistic
 * concurrency guard: a setup page cannot overwrite a replacement connection
 * that became active in another tab.
 */
export const updatePrivateChannelInstance = async (
  c: ValidatedBodyContext<typeof updatePrivateChannelInstanceSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { instanceId, ...input } = c.req.valid("json");
  const scope = { organizationId: auth.organizationId, projectId };
  const repo = getPrivateChannelInstanceRepository(c);
  const active = await repo.getActiveByProject(scope);

  if (!active) throw notFound("Active private channel instance");
  if (active.id !== instanceId) {
    throw new AppError(
      "CONFLICT",
      "The active Private Channels instance changed. Refresh this page before saving."
    );
  }

  assertApprovedPrivateChannelDestinations(c.env, {
    gatewayUrl: input.gatewayUrl,
    authUrl: input.authUrl,
  });

  const projectRpc = await loadPrivateChannelProjectRpcClient(c);
  const probe = await verifyInstanceConnection(c.env, {
    gatewayUrl: input.gatewayUrl,
    authUrl: input.authUrl,
    probeRpc: () =>
      projectRpc.probe({
        escrowProgramId: input.escrowProgramId,
        escrowInstanceAddr: input.escrowInstanceAddr,
      }),
  });
  if (!probe.ok) {
    const summary = toProbeResultDto(probe);
    getLogger().warn(
      redactCredentialSecrets({
        organizationId: auth.organizationId,
        projectId,
        gatewayUrl: input.gatewayUrl,
        authUrl: input.authUrl,
        rpcProvider: projectRpc.target.providerId,
        gateway: summary.gateway,
        rpc: summary.rpc,
        auth: summary.auth,
      }),
      "updatePrivateChannelInstance: connection probe failed"
    );
    const { ok: _ok, ...detail } = summary;
    throw badRequest("Connection check failed", detail);
  }

  const row = await repo.updateActive({ id: active.id, ...scope, ...input });
  if (!row) {
    throw new AppError(
      "CONFLICT",
      "The active Private Channels instance changed. Refresh this page before saving."
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
  const scope = { organizationId: auth.organizationId, projectId };

  // Disconnecting retires the gateway this project's movements run against, so
  // it uses the same durable drain/admission barrier as deletion (HOO-1011,
  // SOLA9-468): the draining flag must persist even when the disconnect below
  // is refused, so every later admission keeps refusing. A transfer still
  // `pending`/`submitted` has no reconciler — replay resolves it only against
  // its OWN instance — so a disconnect that landed while movements were in
  // flight, followed by a different-gateway replacement, would strand them.
  const draining = await repo.beginDraining(scope);
  if (!draining) {
    throw notFound("Active private channel instance");
  }
  const drainToken = draining.draining_token;
  if (drainToken === null) {
    throw new AppError(
      "CONFLICT",
      "The Private Channels instance is no longer draining. Try again."
    );
  }

  // Counting and deactivating are ONE unit under the instance row lock.
  // Admission inserts take the same lock, so the counts cannot grow between
  // the check and the disconnect, and a failure anywhere rolls the disconnect
  // back while leaving the committed drain in place for a retry.
  const outcome = await getDb(c.env).transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const instances = createPostgresPrivateChannelInstanceRepository(client);
    const locked = await instances.lockActiveForDeletion(scope, drainToken);
    if (!locked) {
      return { deactivated: false as const, inFlight: null, locked: null, row: null };
    }

    const [deposits, withdrawals, transfers] = await Promise.all([
      createPostgresPrivateChannelDepositRepository(client).countNonTerminalByInstance(locked.id),
      createPostgresPrivateChannelWithdrawalRepository(client).countNonTerminalByInstance(
        locked.id
      ),
      createPostgresPrivateChannelTransferRepository(client).countNonTerminalByInstance(locked.id),
    ]);
    if (deposits > 0 || withdrawals > 0 || transfers > 0) {
      return {
        deactivated: false as const,
        inFlight: { deposits, withdrawals, transfers },
        locked,
        row: null,
      };
    }

    const deactivated = await instances.deactivateActive(scope);
    if (!deactivated) {
      throw new AppError("CONFLICT", "The active Private Channels instance changed. Try again.");
    }
    return { deactivated: true as const, inFlight: null, locked, row: deactivated };
  });

  if (!outcome.deactivated) {
    if (!outcome.inFlight) {
      // The drain this disconnect established is gone: the instance was resumed
      // (or replaced) while the request was running, and disconnecting whatever
      // is active now would contradict the answer that resume already gave.
      throw new AppError(
        "CONFLICT",
        "This instance was resumed or replaced while the disconnect was running; nothing was disconnected. Try again if you still want it disconnected."
      );
    }
    // The drain stays in place on purpose, exactly as a refused deletion does:
    // reverting it would reopen admission and turn disconnect back into a
    // retry against a moving target. Updating the connection clears the drain,
    // so the operator keeps an explicit way to resume without editing the
    // database.
    const { deposits, withdrawals, transfers } = outcome.inFlight;
    throw new AppError(
      "CONFLICT",
      `This instance is draining for disconnect: ${deposits} deposit(s), ${withdrawals} withdrawal(s), and ${transfers} transfer(s) are still in flight. New movements are refused; retry once they settle or fail, or update the connection to resume this instance.`
    );
  }

  // Emitted from the row the transaction actually locked and deactivated, only
  // after that commit: `draining` was read before the drain, so a concurrent
  // disconnect-and-reconnect in between would have this request announce a
  // disconnection of an instance it did not disconnect.
  const disconnectedInstance = outcome.locked;
  await emitLifecycle(
    c,
    disconnectedInstance,
    PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_DISCONNECTED,
    { payload: { gatewayUrl: disconnectedInstance.gateway_url } }
  );

  const response: PrivateChannelInstanceResponse = {
    instance: mapPrivateChannelInstanceRow(outcome.row),
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

  // Money movements are financial records that survive instance deletion, but
  // deleting an instance with IN-FLIGHT movements would strand their
  // reconciliation. Deletion therefore drains first, in its own transaction:
  // the durable draining flag must persist even when the deletion below is
  // refused, so every later admission keeps refusing (HOO-1011).
  const draining = await repo.beginDraining(scope);
  if (!draining) {
    throw notFound("Active private channel instance");
  }
  // The drain this request is acting on. Everything below is guarded by it, so
  // a resume that lands in between abandons this deletion instead of having it
  // delete the instance the operator just kept.
  const drainToken = draining.draining_token;
  if (drainToken === null) {
    throw new AppError(
      "CONFLICT",
      "The Private Channels instance is no longer draining. Try again."
    );
  }

  // Counting and deleting are ONE unit under the instance row lock. Admission
  // inserts take the same lock, so the counts cannot grow between the check and
  // the delete, and a failure anywhere rolls the delete back while leaving the
  // committed drain in place for a retry.
  const outcome = await getDb(c.env).transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const instances = createPostgresPrivateChannelInstanceRepository(client);
    const locked = await instances.lockActiveForDeletion(scope, drainToken);
    if (!locked) {
      return { deleted: false as const, inFlight: null, locked: null };
    }

    const [deposits, withdrawals, transfers] = await Promise.all([
      createPostgresPrivateChannelDepositRepository(client).countNonTerminalByInstance(locked.id),
      createPostgresPrivateChannelWithdrawalRepository(client).countNonTerminalByInstance(
        locked.id
      ),
      createPostgresPrivateChannelTransferRepository(client).countNonTerminalByInstance(locked.id),
    ]);
    if (deposits > 0 || withdrawals > 0 || transfers > 0) {
      return { deleted: false as const, inFlight: { deposits, withdrawals, transfers }, locked };
    }

    const deleted = await instances.deleteActive(scope, drainToken);
    if (!deleted) {
      throw new AppError("CONFLICT", "The active Private Channels instance changed. Try again.");
    }
    return { deleted: true as const, inFlight: null, locked };
  });

  if (!outcome.deleted) {
    if (!outcome.inFlight) {
      // The drain this deletion established is gone: the instance was resumed
      // (or replaced) while the request was running, and deleting whatever is
      // active now would contradict the answer that resume already gave.
      throw new AppError(
        "CONFLICT",
        "This instance was resumed or replaced while the deletion was running; nothing was deleted. Delete again if you still want it gone."
      );
    }
    // The drain stays in place on purpose: this is the deliberate-disconnect
    // path, and reverting it would reopen admission and turn deletion back
    // into a retry against a moving target.
    //
    // But a drain must not be a one-way door. A private-channel transfer has
    // no reconciler — a silently dropped submission stays `submitted` forever
    // (see services/private-channels/transfer-confirm.ts) — so "retry once
    // they settle" can be advice that never comes true, and the instance would
    // sit refusing every movement with no way back. Updating the connection
    // clears the drain, so the operator keeps an explicit way to resume
    // without editing the database.
    const { deposits, withdrawals, transfers } = outcome.inFlight;
    throw new AppError(
      "CONFLICT",
      `This instance is draining for deletion: ${deposits} deposit(s), ${withdrawals} withdrawal(s), and ${transfers} transfer(s) are still in flight. New movements are refused; retry once they settle or fail, or update the connection to resume this instance.`
    );
  }

  // Emitted from the row the transaction actually locked and deleted, only
  // after that commit: `active` was read before the drain, so a concurrent
  // disconnect-and-reconnect in between would have this request announce the
  // deletion of an instance it did not delete.
  const deletedInstance = outcome.locked;
  await emitLifecycle(
    c,
    deletedInstance,
    PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_DISCONNECTED,
    { payload: { gatewayUrl: deletedInstance.gateway_url, reason: "deleted" } }
  );

  return success(c, { deleted: true });
};
