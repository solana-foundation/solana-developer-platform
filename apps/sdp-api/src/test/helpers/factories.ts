import type { Token, TokenTransaction } from "@sdp/types/tokens";

let tokenCounter = 0;

// ═══════════════════════════════════════════════════════════════════════════
// Token
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenOverrides {
  id?: string;
  projectId?: string;
  organizationId?: string;
  signingCustodyWalletId?: string | null;
  mintAddress?: string | null;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  name?: string;
  symbol?: string;
  decimals?: number;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
  extensions?: Token["extensions"];
  totalSupply?: string;
  totalSupplyUpdatedAt?: string | null;
  maxSupply?: string | null;
  isMintable?: boolean;
  isFreezable?: boolean;
  requiresAllowlist?: boolean;
  template?: Token["template"];
  ablListAddress?: string | null;
  status?: Token["status"];
  deployedAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createToken(overrides: TokenOverrides = {}): Token {
  const n = ++tokenCounter;
  return {
    id: `tok_factory_${n.toString().padStart(8, "0")}`,
    projectId: `prj_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
    signingCustodyWalletId: null,
    signingWalletId: null,
    mintAddress: null,
    mintAuthority: null,
    freezeAuthority: null,
    name: `Factory Token ${n}`,
    symbol: `FT${n}`,
    decimals: 9,
    description: "Test token created by factory",
    uri: null,
    imageUrl: null,
    extensions: null,
    totalSupply: "0",
    totalSupplyUpdatedAt: "2024-01-01T00:00:00.000Z",
    maxSupply: null,
    isMintable: true,
    isFreezable: true,
    requiresAllowlist: false,
    template: "custom",
    ablListAddress: null,
    status: "pending",
    deployedAt: null,
    createdBy: `key_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Token Transaction
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenTransactionOverrides {
  id?: string;
  tokenId?: string;
  organizationId?: string;
  custodyWalletId?: string | null;
  type?: TokenTransaction["type"];
  status?: TokenTransaction["status"];
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  signature?: string | null;
  serializedTx?: string | null;
  params?: Record<string, unknown>;
  slot?: number | null;
  blockTime?: string | null;
  fee?: number | null;
  error?: string | null;
  initiatedByKeyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function createTokenTransaction(
  overrides: TokenTransactionOverrides = {}
): TokenTransaction {
  const n = tokenCounter; // Use current token counter
  return {
    id: `ttx_factory_${n.toString().padStart(8, "0")}`,
    tokenId: `tok_factory_${n.toString().padStart(8, "0")}`,
    organizationId: `org_factory_${n.toString().padStart(8, "0")}`,
    custodyWalletId: null,
    type: "mint",
    status: "pending",
    idempotencyKey: null,
    idempotencyFingerprint: null,
    signature: null,
    serializedTx: null,
    params: {
      destination: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      amount: "1",
    },
    slot: null,
    blockTime: null,
    fee: null,
    error: null,
    initiatedByKeyId: `key_factory_${n.toString().padStart(8, "0")}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}
