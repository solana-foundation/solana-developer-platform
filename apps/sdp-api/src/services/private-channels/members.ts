// Principal provisioning: derive an SPC username, generate a strong random
// password, register with SPC, encrypt the password, then persist the principal.

import { PrivateChannelError, spcLogin, spcRegister } from "@sdp/private-channels";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PrivateChannelUserRepository,
  PrivateChannelUserRow,
  ProjectScope,
} from "@/db/repositories";
import { conflict } from "@/lib/errors";
import {
  createSpcCredentialCipher,
  type SpcCredentialCipherEnv,
} from "@/lib/spc-credential-crypto";
import { getLogger } from "@/runtime/logger";

const SPC_USERNAME_MIN = 5;
const SPC_USERNAME_MAX = 32;
const SPC_PASSWORD_BYTES = 32;
const SPC_USERNAME_ALLOWED = /[^a-zA-Z0-9_-]/g;
const SPC_USERNAME_SUFFIX_LEN = 5;
// 32 characters (lowercase base32), so `byte & 31` selects one uniformly.
// biome-ignore lint/security/noSecrets: Character alphabet, not a secret.
const SPC_USERNAME_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export interface ProvisionPrincipalInput extends ProjectScope {
  instanceId: string;
  authUrl: string;
  name: string;
  isDefault: boolean;
  createdBy: string | null;
}

export interface ProvisionPrincipalResult {
  principal: PrivateChannelUserRow;
  created: boolean;
}

// Display name → SPC-safe username. The suffix prevents collisions between
// principals with similar names on the same or an external SPC instance.
function deriveUsername(name: string): string {
  const slug = name.replace(SPC_USERNAME_ALLOWED, "-");
  // Reserve the separator + suffix so the final slice can never truncate the
  // suffix away (that would silently spend the collision space).
  const reserved = SPC_USERNAME_SUFFIX_LEN + 1;
  const base = slug.replace(/^-+|-+$/g, "").slice(0, SPC_USERNAME_MAX - reserved);
  const seed = base.length >= SPC_USERNAME_MIN - reserved ? base : `user-${base}`;
  return `${seed}-${randomSuffix()}`.slice(0, SPC_USERNAME_MAX);
}

/**
 * Fixed-length random suffix. `getRandomValues` rather than `Math.random()`, to
 * match every other random value in this module. Fixed length because a base-36
 * numeric conversion drops leading zeros, which would shorten the suffix at random
 * and eat into the collision space it exists to provide. The alphabet is
 * 32 characters so a byte maps to one character uniformly by masking, with no
 * modulo bias and no rejection loop.
 */
function randomSuffix(): string {
  const bytes = new Uint8Array(SPC_USERNAME_SUFFIX_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SPC_USERNAME_SUFFIX_ALPHABET[byte & 31]).join("");
}

function generatePassword(): string {
  const bytes = new Uint8Array(SPC_PASSWORD_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

interface PrincipalReservation {
  row: PrivateChannelUserRow;
  username: string;
  password: string;
  ciphertext: string;
  created: boolean;
}

async function reserveOrResumePrincipal(
  repo: PrivateChannelUserRepository,
  input: ProvisionPrincipalInput,
  cipher: ReturnType<typeof createSpcCredentialCipher>
): Promise<PrincipalReservation | ProvisionPrincipalResult> {
  const password = generatePassword();
  const username = deriveUsername(input.name);
  const ciphertext = await cipher.encrypt(input.organizationId, password);

  try {
    const row = await repo.reservePrincipal({
      organizationId: input.organizationId,
      projectId: input.projectId,
      instanceId: input.instanceId,
      name: input.name,
      isDefault: input.isDefault,
      createdBy: input.createdBy,
      spcUsername: username,
      spcCredentialCiphertext: ciphertext,
    });
    return { row, username, password, ciphertext, created: true };
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) throw error;

    const pending = await repo.findPrincipalReservation(input);
    if (pending?.spc_username && pending.spc_credential_ciphertext) {
      return {
        row: pending,
        username: pending.spc_username,
        password: await cipher.decrypt(input.organizationId, pending.spc_credential_ciphertext),
        ciphertext: pending.spc_credential_ciphertext,
        created: false,
      };
    }

    if (input.isDefault) {
      const existing = await repo.findDefaultPrincipal(input, input.instanceId);
      if (existing) return { principal: existing, created: false };
    }
    throw conflict("An active Private Channels identity already uses this name.");
  }
}

async function registerOrResumeSpcUser(
  repo: PrivateChannelUserRepository,
  input: ProvisionPrincipalInput,
  reservation: PrincipalReservation
): Promise<{ spcUserId: string | null; username: string }> {
  try {
    const registered = await spcRegister(input.authUrl, {
      username: reservation.username,
      password: reservation.password,
    });
    return { spcUserId: registered.id, username: registered.username };
  } catch (error) {
    if (!(error instanceof PrivateChannelError) || error.code !== "CONFLICT") throw error;
  }

  // A matching login means a previous attempt registered this persisted
  // credential but stopped before completing the local reservation.
  try {
    await spcLogin(input.authUrl, {
      username: reservation.username,
      password: reservation.password,
    });
    return { spcUserId: reservation.row.spc_user_id, username: reservation.username };
  } catch (error) {
    if (!(error instanceof PrivateChannelError) || error.code !== "UNAUTHORIZED") throw error;
    await repo.deletePrincipalReservation(input, reservation.row.id);
    throw conflict("The generated Private Channels username is unavailable. Try again.");
  }
}

async function findCompletedReservation(
  repo: PrivateChannelUserRepository,
  input: ProvisionPrincipalInput,
  reservationId: string
): Promise<PrivateChannelUserRow | null> {
  try {
    const current = await repo.getById(input, reservationId);
    return current && (current.spc_user_id || current.provisioned_at) ? current : null;
  } catch (statusError) {
    getLogger().warn(
      { reservationId, statusError },
      "private-channel identity: could not read a concurrent provisioning result"
    );
    return null;
  }
}

/**
 * Provision an SPC credential for a project principal. A principal represents a
 * financial or operational participant; it never represents the SDP actor who
 * clicked the button.
 */
export async function provisionPrincipal(
  env: SpcCredentialCipherEnv,
  repo: PrivateChannelUserRepository,
  input: ProvisionPrincipalInput
): Promise<ProvisionPrincipalResult> {
  if (input.isDefault) {
    const existing = await repo.findDefaultPrincipal(input, input.instanceId);
    if (existing) return { principal: existing, created: false };
  }

  const cipher = createSpcCredentialCipher(env);
  // Claim the tenant-scoped name/default slot before creating an upstream SPC
  // user. The encrypted credentials live on the reservation, so a retry resumes
  // the exact same registration after a crash or ambiguous network response.
  const reservation = await reserveOrResumePrincipal(repo, input, cipher);
  if ("principal" in reservation) return reservation;

  try {
    const registered = await registerOrResumeSpcUser(repo, input, reservation);

    const principal = await repo.completePrincipal({
      organizationId: input.organizationId,
      projectId: input.projectId,
      id: reservation.row.id,
      spcUserId: registered.spcUserId,
      spcUsername: registered.username,
      spcCredentialCiphertext: reservation.ciphertext,
    });
    return { principal, created: reservation.created };
  } catch (error) {
    // Another retry may have completed the same persisted credential while this
    // request was at SPC. Converge on that active row instead of failing it.
    const current = await findCompletedReservation(repo, input, reservation.row.id);
    if (current) return { principal: current, created: false };
    throw error;
  }
}
