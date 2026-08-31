// Principal provisioning: derive an SPC username, generate a strong random
// password, register with SPC, encrypt the password, then persist the principal.

import { PrivateChannelError, spcRegister } from "@sdp/private-channels";
import type {
  PrivateChannelUserRepository,
  PrivateChannelUserRow,
  ProjectScope,
} from "@/db/repositories";
import {
  createSpcCredentialCipher,
  type SpcCredentialCipherEnv,
} from "@/lib/spc-credential-crypto";

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

  const password = generatePassword();
  const cipher = createSpcCredentialCipher(env);
  const ciphertext = await cipher.encrypt(input.organizationId, password);

  let username = deriveUsername(input.name);
  let registered: Awaited<ReturnType<typeof spcRegister>>;
  try {
    registered = await spcRegister(input.authUrl, { username, password });
  } catch (error) {
    if (error instanceof PrivateChannelError && error.code === "CONFLICT") {
      username = deriveUsername(input.name);
      registered = await spcRegister(input.authUrl, { username, password });
    } else {
      throw error;
    }
  }

  const principal = await repo.createPrincipal({
    organizationId: input.organizationId,
    projectId: input.projectId,
    instanceId: input.instanceId,
    name: input.name,
    isDefault: input.isDefault,
    spcUserId: registered.id,
    spcUsername: registered.username,
    spcCredentialCiphertext: ciphertext,
    createdBy: input.createdBy,
  });
  return { principal, created: true };
}
