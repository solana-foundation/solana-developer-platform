// Invite orchestration: derive an SPC username, generate a strong random
// password, register with SPC, encrypt the password, insert the DB row.
// SPC /register MUST succeed before we persist so a partial invite doesn't
// leave a row without credentials.

import { PrivateChannelError, spcRegister } from "@sdp/private-channels";
import type {
  PrivateChannelUserRepository,
  PrivateChannelUserWithIdentityRow,
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

export interface InviteMemberInput extends ProjectScope {
  authUrl: string;
  targetUserId: string;
  targetUserEmail: string;
  invitedBy: string | null;
}

export interface InviteMemberResult {
  member: PrivateChannelUserWithIdentityRow;
  /** Base64url token to embed in the invite URL. Persisted on the row. */
  inviteToken: string;
}

// email → SPC-safe username. Adds a short random suffix so collisions between
// same-email invites across projects (or a project + external SPC instance)
// don't fail the first try.
function deriveUsername(email: string): string {
  const slug = email.split("@")[0]?.replace(SPC_USERNAME_ALLOWED, "-") ?? "user";
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

function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function inviteMember(
  env: SpcCredentialCipherEnv,
  repo: PrivateChannelUserRepository,
  input: InviteMemberInput
): Promise<InviteMemberResult> {
  // Dup check: prevents burning an SPC username on a doomed insert.
  const existing = await repo.findByProjectAndUser(input, input.targetUserId);
  if (existing) {
    throw new PrivateChannelError(
      "CONFLICT",
      "User is already invited to this Private Channels workspace."
    );
  }

  const password = generatePassword();
  const cipher = createSpcCredentialCipher(env);
  const ciphertext = await cipher.encrypt(input.organizationId, password);

  // Retry once on collision: SPC hard-fails on duplicate username; the random
  // suffix makes second-attempt collisions effectively impossible.
  let username = deriveUsername(input.targetUserEmail);
  let registered: Awaited<ReturnType<typeof spcRegister>>;
  try {
    registered = await spcRegister(input.authUrl, { username, password });
  } catch (err) {
    if (err instanceof PrivateChannelError && err.code === "CONFLICT") {
      username = deriveUsername(input.targetUserEmail);
      registered = await spcRegister(input.authUrl, { username, password });
    } else {
      throw err;
    }
  }

  const inviteToken = generateInviteToken();
  const member = await repo.create({
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.targetUserId,
    spcUserId: registered.id,
    spcUsername: registered.username,
    spcCredentialCiphertext: ciphertext,
    invitedBy: input.invitedBy,
    inviteToken,
  });

  return { member, inviteToken };
}
