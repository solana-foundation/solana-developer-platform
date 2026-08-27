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
 * identity, which SDP treats as a conflict, so it is versioned rather than edited.
 */
const HKDF_SALT = "sdp/helius-rings/deterministic-ka/v1";

/**
 * A viewing candidate is occasionally out of range for a P-256 scalar. Walking a
 * counter rather than mangling the bytes keeps the derivation reproducible.
 */
const MAX_VIEWING_KEY_ATTEMPTS = 8;

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
    // Without this, "a/b" + "c" + "d" and "a" + "b" + "c/d" build one path, so
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
 * Derives one wallet's material from the master seed. Service code should go
 * through {@link createDeterministicMaterialSource}, which destroys the keys for
 * it; this is exported for callers that manage the lifetime themselves.
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
  /** 32 raw bytes; normally {@link DETERMINISTIC_KA_SEED}. */
  readonly seed: Uint8Array;
}

/**
 * A {@link ShieldedMaterialSource} that recomputes material from one master seed
 * on every request, so nothing is stored at rest. Interim: the seed is public,
 * so not storing these keys does not make them secret.
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
