/**
 * Custody Services
 *
 * Re-exports all custody-related services and types.
 *
 * Usage:
 * ```typescript
 * import { CustodyService, LocalKeypairProvider } from "@/services/custody";
 * ```
 */

// Main service
export { CustodyService } from "./custody.service";
export { CustodyConfigStore } from "./config-store";
export { CustodyProviderRegistry, createDefaultRegistry } from "./provider-registry";
export { SigningRequestStore } from "./signing-request-store";

// Providers
export { LocalKeypairProvider } from "./local-keypair.provider";
export { FireblocksProvider } from "./fireblocks/provider";

// Types
export type {
  // Core interface
  CustodyProvider,
  // Request/Response
  SignRequest,
  SignResponse,
  SignerInfo,
  SigningMetadata,
  SignatureInfo,
  SignatureStatus,
  GeneratedKeypair,
  CustodySignResult,
  // Configuration
  CustodyProviderType,
  CustodyConfigBase,
  CustodyConfiguration,
  LocalCustodyConfig,
  FireblocksCustodyConfig,
  DfnsCustodyConfig,
  TurnkeyCustodyConfig,
  // Database records
  CustodyConfigRecord,
  SigningRequestRecord,
} from "./types";
