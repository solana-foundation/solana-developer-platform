/**
 * Signing Port
 *
 * Implementation moved to the @sdp/custody workspace package; this module
 * re-exports it so existing import paths keep working.
 */

export {
  type FullSigningPort,
  type GeneratedKeypair,
  isFullSigningPort,
  SigningError,
  type SigningErrorCode,
  type SigningMetadata,
  type SigningPort,
  type SignRequest,
  type SignResult,
  type SignResultStatus,
  type SignStatus,
} from "@sdp/custody";
