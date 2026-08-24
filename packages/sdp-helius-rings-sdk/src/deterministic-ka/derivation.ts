import { hkdfSync } from "node:crypto";
import {
  createShieldedMaterial,
  isValidViewingKeyBytes,
  type MaterialRequest,
  NULLIFIER_KEY_BYTE_LENGTH,
  type ShieldedMaterial,
  type ShieldedMaterialSource,
  VIEWING_KEY_BYTE_LENGTH,
} from "../material.js";
import { SEED_BYTE_LENGTH } from "./seed.js";

/**
 * Domain separator for every key derived here. Changing it re-keys every
 * identity, which on a registered wallet is an identity conflict rather than a
 * rotation, so it is versioned instead of edited.
 */
const HKDF_SALT = "sdp/helius-rings/deterministic-ka/v1";

/**
 * A viewing candidate is occasionally out of range for a P-256 scalar. Walk a
 * counter rather than mangling the bytes: the accepted counter is part of the
 * derivation and stays reproducible.
 */
const MAX_VIEWING_KEY_ATTEMPTS = 8;

/** Separates the components of a derivation path. */
const PATH_SEPARATOR = "/";

function derivationPath(request: MaterialRequest): string {
  const components: ReadonlyArray<readonly [string, string]> = [
    ["organizationId", request.organizationId],
    ["projectId", request.projectId],
    ["walletId", request.walletId],
  ];

  for (const [name, value] of components) {
    if (value.length === 0) {
      throw new Error(`A Rings material request needs a ${name}.`);
    }
    // Without this, {organizationId: "a/b", projectId: "c"} and
    // {organizationId: "a", projectId: "b", walletId: "c/d"} build one path, so
    // two tenants would derive the same viewing and nullifier key.
    if (value.includes(PATH_SEPARATOR)) {
      throw new Error(`A Rings ${name} must not contain "${PATH_SEPARATOR}".`);
    }
  }

  return components.map(([, value]) => value).join(PATH_SEPARATOR);
}

function derive(seed: Uint8Array, info: string, length: number): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", seed, HKDF_SALT, info, length));
}

function selectViewingKeyBytes(seed: Uint8Array, path: string): Uint8Array {
  for (let counter = 0; counter < MAX_VIEWING_KEY_ATTEMPTS; counter += 1) {
    const candidate = derive(seed, `viewing/${path}/${counter}`, VIEWING_KEY_BYTE_LENGTH);
    if (isValidViewingKeyBytes(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not derive a viewing key for ${path} in ${MAX_VIEWING_KEY_ATTEMPTS} attempts.`
  );
}

/**
 * Derives one wallet's material from the master seed.
 *
 * Exported for callers that manage the lifetime themselves, which in practice
 * means tests that hold one identity across several steps. Service code should
 * go through {@link createDeterministicMaterialSource} so the keys are
 * destroyed for it.
 */
export async function deriveMaterial(
  seed: Uint8Array,
  request: MaterialRequest
): Promise<ShieldedMaterial> {
  if (seed.length !== SEED_BYTE_LENGTH) {
    throw new Error(`The Rings derivation seed must be ${SEED_BYTE_LENGTH} bytes.`);
  }

  const path = derivationPath(request);

  return createShieldedMaterial({
    viewingKeyBytes: selectViewingKeyBytes(seed, path),
    nullifierKeyBytes: derive(seed, `nullifier/${path}`, NULLIFIER_KEY_BYTE_LENGTH),
    owner: request.owner,
  });
}

export interface DeterministicMaterialSourceConfig {
  /** 32 raw bytes, normally from `decodeSeed`. The caller keeps it out of logs. */
  readonly seed: Uint8Array;
}

/**
 * A {@link ShieldedMaterialSource} that recomputes material from one master
 * seed on every request, so no shielded secret is ever stored at rest.
 *
 * It is also the interim answer to a question this integration has not settled:
 * what makes it interim is that the platform holds the seed and can therefore
 * derive every tenant's viewing and nullifier keys, not that the derivation is
 * deterministic. Replacing it means writing another `ShieldedMaterialSource`
 * and deleting this directory and its entry point; nothing downstream of the
 * interface changes.
 */
export function createDeterministicMaterialSource(
  config: DeterministicMaterialSourceConfig
): ShieldedMaterialSource {
  return {
    async withMaterial(request, use) {
      const material = await deriveMaterial(config.seed, request);

      try {
        return await use(material);
      } finally {
        material.destroy();
      }
    },
  };
}
