import {
  CUSTODY_CONNECTION_LIFECYCLES,
  CUSTODY_PROVIDERS,
  PROVIDER_CREDENTIAL_STATUSES,
  type CustodyWalletSummary,
} from "@sdp/types";
import { z } from "zod";
import type { SdpApiClient } from "@/lib/sdp-api";
import { connectionsPageEnvelopeSchema, type CustodyConnectionListItem } from "./connections.data";

/**
 * The API grants exactly 24 hours of secret retention at cut-over
 * (`secret_retention_expires_at = now + interval '24 hours'`), and exposes only
 * the deadline. The moment the predecessor was retired is therefore the
 * deadline minus that window, which is what the credentials card labels
 * "Retired".
 */
export const ROLLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

const COMPLETION_STATUSES = ["running", "success", "failed", "retry_unknown"] as const;

/**
 * Widened past `CUSTODY_CONNECTION_FAILURE_CODES` on purpose: the installation
 * view reports the same four codes, but an unknown one must not fail the parse
 * and blank the page. Unrecognised codes fall through to the generic outcome.
 */
const completionSchema = z.object({
  status: z.enum(COMPLETION_STATUSES),
  attemptedAt: z.string(),
  code: z.string().optional(),
});

const installationConnectionSchema = z.object({
  id: z.string(),
  provider: z.enum(CUSTODY_PROVIDERS),
  label: z.string(),
  status: z.enum(CUSTODY_CONNECTION_LIFECYCLES),
  completion: completionSchema.nullable(),
  walletLabel: z.string().optional(),
  isDefault: z.boolean(),
  canComplete: z.boolean(),
  canReplaceCredentials: z.boolean(),
  canCancel: z.boolean(),
});

const safeCredentialSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  scope: z.enum(["organization", "project"]),
  projectId: z.string().nullable(),
  status: z.enum(PROVIDER_CREDENTIAL_STATUSES),
  createdAt: z.string(),
  displayMetadata: z.object({ appIdSuffix: z.string().optional() }),
  source: z.enum(["stored", "runtime"]),
});

const lifecycleSchema = z.object({
  providerCredential: safeCredentialSchema,
  rotationCandidate: safeCredentialSchema.nullable(),
  impact: z.object({
    projects: z.array(z.object({ id: z.string(), name: z.string() })),
    connections: z.array(
      z.object({ id: z.string(), projectId: z.string(), status: z.string() })
    ),
  }),
  rollback: z
    .object({ providerCredential: safeCredentialSchema, expiresAt: z.string() })
    .nullable(),
});

const installationEnvelopeSchema = z.object({
  data: z.object({ connection: installationConnectionSchema }),
});
const lifecycleEnvelopeSchema = z.object({ data: lifecycleSchema });

export type CustodyConnectionCompletion = z.infer<typeof completionSchema>;
export type CustodyInstallationConnection = z.infer<typeof installationConnectionSchema>;
export type LifecycleCredential = z.infer<typeof safeCredentialSchema>;
export type CustodyCredentialLifecycle = z.infer<typeof lifecycleSchema>;

export class ConnectionDetailRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Custody connection request failed (${status})`);
    this.name = "ConnectionDetailRequestError";
    this.status = status;
  }
}

export async function fetchConnectionInstallation(
  request: SdpApiClient["request"],
  connectionId: string
): Promise<CustodyInstallationConnection> {
  const res = await request(
    `/internal/dashboard/custody/connections/${encodeURIComponent(connectionId)}`
  );
  if (!res.ok) {
    throw new ConnectionDetailRequestError(res.status);
  }
  return installationEnvelopeSchema.parse(await res.json()).data.connection;
}

/**
 * Returns `null` rather than throwing when the lifecycle view is unreadable.
 * A connection whose credentials cannot be loaded is still worth rendering —
 * its wallets, status and setup actions do not depend on this read, and the
 * credentials card says so itself rather than taking the page down.
 *
 * The one exception is authorization: a caller who is not a member of every
 * project the credential touches gets 403 by design, and that is a settled
 * answer, not a failed read.
 */
export async function fetchCredentialLifecycle(
  request: SdpApiClient["request"],
  connectionId: string
): Promise<CustodyCredentialLifecycle | "restricted" | null> {
  try {
    const res = await request(
      `/internal/dashboard/custody/connections/${encodeURIComponent(connectionId)}/provider-credential`
    );
    if (res.status === 403) {
      return "restricted";
    }
    if (!res.ok) {
      return null;
    }
    return lifecycleEnvelopeSchema.parse(await res.json()).data;
  } catch {
    return null;
  }
}

/**
 * The list row for one connection, which carries display facts the
 * installation view does not: when it was created, whether the project points
 * at it by default, and — the one that matters most — whether signing is
 * currently permitted through it.
 *
 * Found by paging the project's own list rather than by a dedicated endpoint,
 * because there isn't one. The page walk is bounded: a project with more
 * connections than this has other problems, and the header degrades to hiding
 * the two optional facts rather than failing the page.
 *
 * Returns `null` when the row cannot be found or read; every caller treats
 * that as "show the rest".
 */
export async function fetchConnectionListItem(
  request: SdpApiClient["request"],
  connectionId: string
): Promise<CustodyConnectionListItem | null> {
  const pageSize = 50;
  const maxPages = 4;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const res = await request(
        `/internal/dashboard/custody/connections?limit=${pageSize}&offset=${page * pageSize}`
      );
      if (!res.ok) return null;
      const parsed = connectionsPageEnvelopeSchema.parse(await res.json()).data;
      const match = parsed.connections.find((row) => row.id === connectionId);
      if (match) return match;
      if ((page + 1) * pageSize >= parsed.pagination.total) return null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchConnectionWallets(
  request: SdpApiClient["request"],
  connectionId: string
): Promise<CustodyWalletSummary[]> {
  const res = await request(
    "/v1/wallets?includeAllProviders=true&includeBalances=true&view=summary"
  );
  if (!res.ok) {
    throw new ConnectionDetailRequestError(res.status);
  }
  const json = (await res.json()) as { data: { wallets: CustodyWalletSummary[] } };
  return json.data.wallets.filter((wallet) => wallet.custodyConnectionId === connectionId);
}

/**
 * Rotation and rollback are offered only for credentials SDP stores. Ones the
 * deployment supplies are held in the environment, so there is nothing here to
 * replace — the API refuses both with a 409 regardless.
 */
export function isCredentialManagedHere(credential: LifecycleCredential): boolean {
  return credential.source === "stored";
}

/**
 * The retired predecessor's cut-over moment, derived from the deadline the API
 * publishes. See {@link ROLLBACK_WINDOW_MS}.
 */
export function resolveRetiredAt(expiresAt: string): Date | null {
  const deadline = Date.parse(expiresAt);
  return Number.isNaN(deadline) ? null : new Date(deadline - ROLLBACK_WINDOW_MS);
}

/**
 * Whole hours left in the rollback window, for the "(19 h left)" caption.
 * Returns 0 once the deadline has passed rather than a negative count: an
 * expired window is not a window, and the control is withdrawn at that point.
 */
export function rollbackHoursRemaining(expiresAt: string, now: number = Date.now()): number {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return 0;
  return Math.max(0, Math.floor((deadline - now) / (60 * 60 * 1000)));
}

/**
 * A rollback the user can actually take: the API must still be offering one,
 * and no unfinished rotation candidate may be sitting in front of it — that
 * case 409s, and the candidate has to be cancelled first.
 */
export function canRollBack(lifecycle: CustodyCredentialLifecycle, now: number = Date.now()) {
  if (!lifecycle.rollback) {
    return { available: false as const, reason: "no_target" as const };
  }
  if (lifecycle.rotationCandidate) {
    return { available: false as const, reason: "rotation_pending" as const };
  }
  if (Date.parse(lifecycle.rollback.expiresAt) <= now) {
    return { available: false as const, reason: "expired" as const };
  }
  return { available: true as const };
}
