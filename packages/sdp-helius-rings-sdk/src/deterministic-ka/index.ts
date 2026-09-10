export {
  createDeterministicMaterialSource,
  type DerivedKeyBytes,
  type DeterministicMaterialSourceConfig,
  deriveKeyBytes,
  deriveMaterial,
} from "./derivation.js";
export {
  DETERMINISTIC_KA_SEED,
  SEED_BYTE_LENGTH,
  warnDeterministicKeyAuthority,
} from "./seed.js";
