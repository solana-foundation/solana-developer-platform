import type {
  EarnExternalWalletDepositResponse,
  EarnExternalWalletDepositTransactionResponse,
  EarnExternalWalletEarningsResponse,
  EarnExternalWalletMovement,
  EarnExternalWalletMovementsPage,
  EarnExternalWalletPosition,
  EarnExternalWalletPositionSummaryResponse,
  EarnExternalWalletPositionsPage,
  EarnExternalWalletWithdrawalRequestTransactionResponse,
  EarnExternalWalletWithdrawalResponse,
  EarnExternalWalletWithdrawalTransactionResponse,
  EarnStrategy,
  EarnVaultAsyncWithdrawalTermsRequest,
  EarnVaultQueuedWithdrawalPreview,
  EarnVaultWithdrawalOptions,
  EarnVaultWithdrawalRequestRecord,
  EarnVaultWithdrawalRequestResponse,
  EarnVaultWithdrawalRequestsPage,
} from "@sdp/types/earn";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";

/**
 * Whole-request and whole-response examples for the partner Earn operations.
 * The API reference samples a body from its schema, so without these it shows
 * each field's own example or the first enum value, which can describe an
 * impossible state (a `requested` movement with a failure reason). The
 * examples tell one sandbox story, shaped like real local devnet runs: a
 * Kamino deposit and instant withdrawal, and a Veda solver queue request.
 */

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_DEVNET = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const VAULT = "C7N2fqV2GvhFghDf5PJSwstyjedjLNCY1cm2Ak7TeU83";
const SHARE_MINT = "CeirL1mAehaM6g2EccgMUQwohNfnuyicskVQ4r9ekXk6";
const VEDA_VAULT = "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU";
const VEDA_SHARE_MINT = "CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV";
const REQUEST_ADDRESS = "DKw4pYcvXNLs91RssedGFznWRpbvPttp2AAwNCG7fQRz";
const SIGNATURE =
  "3dhkSPLiQZQPXL96fWzMdWJtdbtAffkBKXw2xhsYbV3VNSnYrVAcdx1czsnLsE1ou4SvLecGdSYe4QpAuZdfjJAf";
const UNSIGNED_TRANSACTION =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SIGNED_TRANSACTION =
  "AUyx/sEc49/1l6jxo3nbViPAIUqdrXCo8Qx5SfDvIbtUI0zex3Bi6Cyhhn1QTVU8zWDzXTRyIX2aCmq9v7yk5AOA";

/** IDs in the API's own formats. Each names one object in the story. */
export const EARN_EXAMPLE_IDS = {
  strategy: "earn_strategy_3b6a81ce-00b0-4c5a-9761-cb359932e97e",
  mainnetStrategy: "earn_strategy_8d1f0c52-6a3e-4b7e-9f21-3c5d7a9e4b10",
  depositBuild: "earn_external_wallet_transaction_e7a88258-1d19-48f3-8d0e-81fefa4bf3b3",
  withdrawalBuild: "earn_external_wallet_transaction_0ebe7320-4b8e-4d1a-a5f0-6c2d9e8b1f47",
  requestBuild:
    "earn_external_wallet_withdrawal_request_transaction_54c50679-1b52-494d-84fa-106df66452ff",
  cancelBuild:
    "earn_external_wallet_withdrawal_request_transaction_9a3c1e27-5d84-4f0b-b6e2-7f19c4a8d035",
  depositMovement: "earn_movement_a6aed3f5-4f89-4dc6-9d4b-0864021bd80d",
  withdrawalMovement: "earn_movement_f671de6c-e6f9-4b6f-b390-147eb942cea4",
  position: "earn_position_2f8b6b04-7147-487e-b760-b1caa4fbcb8b",
  vedaPosition: "earn_position_0432ffeb-c574-4b11-80dc-a09defb68fcc",
  withdrawalRequest: "earn_vault_withdrawal_request_3c905ad2-c92c-4258-9675-1899c41569b9",
} as const satisfies Record<string, string>;

const IDS = EARN_EXAMPLE_IDS;

export const EARN_OWNER_ADDRESS_EXAMPLE = OWNER;

export const EARN_STRATEGY_EXAMPLE = {
  id: IDS.mainnetStrategy,
  provider: "kamino",
  providerReference: "BEEfo7xwgK2ZP13Pxo7qqTPzAteKJmXjVWtMWcXSvbn2",
  name: "Steakhouse High Yield USDC",
  sourceKind: "defi",
  underlyingSource: "klend",
  depositMints: [WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address],
  shareMint: "FU2tGk7tFHEhZiZ516TKgpPqPwXYXHTeRHqvuDwa56UV",
  apyType: "variable",
  currentApy: "0.045113",
  liquidityTerm: "instant",
  riskMetadata: { managementFeeBps: 0, performanceFeeBps: 500 },
  status: "active",
  depositSlippage: { quoteRequired: true, defaultToleranceBps: 10 },
  withdrawalSlippage: null,
  hostCluster: "mainnet-beta",
  fundable: true,
  feeSponsored: false,
  createdAt: "2026-11-04T00:17:15.491Z",
  updatedAt: "2026-11-06T17:52:10.042Z",
} satisfies EarnStrategy;

export const EARN_DEPOSIT_PREVIEW_REQUEST_EXAMPLE = { strategyId: IDS.strategy, amount: "25" };

export const EARN_DEPOSIT_PREVIEW_EXAMPLE = {
  strategyId: IDS.strategy,
  sharesOut: "24.975",
  shareDecimals: 6,
  blockingIssues: [],
  feeSponsored: false,
};

/** A sandbox Kamino vault takes no floor, so the build omits `minSharesOut`. */
export const EARN_DEPOSIT_TRANSACTION_REQUEST_EXAMPLE = {
  strategyId: IDS.strategy,
  ownerAddress: OWNER,
  amount: "25",
};

export const EARN_DEPOSIT_TRANSACTION_EXAMPLE = {
  transaction: {
    transactionId: IDS.depositBuild,
    transaction: UNSIGNED_TRANSACTION,
    lastValidBlockHeight: "361186610",
    sponsored: false,
    ownerAddress: OWNER,
    provider: "kamino",
    providerReference: VAULT,
    tokenMint: USDC_DEVNET,
    shareMint: SHARE_MINT,
    amount: "25",
    minSharesOut: null,
    strategy: {
      id: IDS.strategy,
      name: "Kamino Vault USDC",
      provider: "kamino",
      providerReference: VAULT,
      hostCluster: "devnet",
    },
  },
} satisfies EarnExternalWalletDepositTransactionResponse;

export const EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE = {
  transactionId: IDS.depositBuild,
  signedTransaction: SIGNED_TRANSACTION,
};

const DEPOSIT_MOVEMENT = {
  movementId: IDS.depositMovement,
  positionId: IDS.position,
  provider: "kamino",
  providerReference: VAULT,
  direction: "deposit",
  settlement: "atomic",
  signature: SIGNATURE,
  ownerAddress: OWNER,
  amount: "25",
  denomination: USDC_DEVNET,
  tokenMint: USDC_DEVNET,
  failureReason: null,
  createdAt: "2026-11-06T17:57:30.817Z",
} satisfies Omit<
  EarnExternalWalletMovement,
  "status" | "tokenAmount" | "confirmedAt" | "settledAt"
>;

/**
 * A deposit submit's answer: recorded and broadcast, not yet confirmed. A Kamino
 * deposit's `tokenAmount` is its receipt, read at finalization, so it is null here.
 */
export const EARN_DEPOSIT_SUBMIT_EXAMPLE = {
  ...DEPOSIT_MOVEMENT,
  status: "submitted",
  tokenAmount: null,
  confirmedAt: null,
  settledAt: null,
  replayed: false,
} satisfies EarnExternalWalletDepositResponse["deposit"];

/** The same deposit once it is final. */
export const EARN_MOVEMENT_FINALIZED_EXAMPLE = {
  ...DEPOSIT_MOVEMENT,
  status: "finalized",
  tokenAmount: "25",
  confirmedAt: "2026-11-06T17:57:32.517Z",
  settledAt: "2026-11-06T17:57:35.623Z",
} satisfies EarnExternalWalletMovement;

export const EARN_MOVEMENTS_EXAMPLE = {
  ownerAddress: OWNER,
  movements: [EARN_MOVEMENT_FINALIZED_EXAMPLE],
  hasMore: false,
  nextCursor: null,
} satisfies EarnExternalWalletMovementsPage;

const POSITION = {
  id: IDS.position,
  ownerAddress: OWNER,
  provider: "kamino",
  providerReference: VAULT,
  label: "Kamino Vault USDC",
  tokenMint: USDC_DEVNET,
  shareMint: SHARE_MINT,
  createdAt: "2026-11-06T17:57:30.817Z",
  closedAt: null,
  shares: "24.975",
  withdrawableShares: "24.975",
  tokenValue: "25.031",
} satisfies EarnExternalWalletPosition;

export const EARN_POSITIONS_EXAMPLE = {
  ownerAddress: OWNER,
  positions: [POSITION],
  hasMore: false,
  nextCursor: null,
} satisfies EarnExternalWalletPositionsPage;

export const EARN_EARNINGS_EXAMPLE = {
  ownerAddress: OWNER,
  positionCount: 1,
  unavailablePositionCount: 0,
  totalsByToken: [
    {
      tokenMint: USDC_DEVNET,
      positionCount: 1,
      unavailablePositionCount: 0,
      currentValue: "25.031",
      totalDeposited: "25",
      totalWithdrawn: "0",
      earned: "0.031",
    },
  ],
} satisfies EarnExternalWalletEarningsResponse["earnings"];

/** Totals without the personal-data opt-ins: no wallet addresses, no positions. */
export const EARN_POSITION_SUMMARY_EXAMPLE = {
  summary: {
    walletCount: 2,
    positionCount: 2,
    unavailablePositionCount: 0,
    totalsByStrategy: [
      {
        provider: "kamino",
        providerReference: VAULT,
        label: "Kamino Vault USDC",
        walletCount: 2,
        positionCount: 2,
        totalsByToken: [
          {
            tokenMint: USDC_DEVNET,
            walletCount: 2,
            positionCount: 2,
            unavailablePositionCount: 0,
            tokenValue: "50.062",
          },
        ],
      },
    ],
    totalsByToken: [
      {
        tokenMint: USDC_DEVNET,
        walletCount: 2,
        positionCount: 2,
        unavailablePositionCount: 0,
        tokenValue: "50.062",
      },
    ],
  },
} satisfies EarnExternalWalletPositionSummaryResponse;

/** Kamino's withdrawal takes no floor, so neither body carries `minAmountOut`. */
export const EARN_WITHDRAWAL_PREVIEW_REQUEST_EXAMPLE = { positionId: IDS.position, shares: "10" };

export const EARN_WITHDRAWAL_PREVIEW_EXAMPLE = {
  positionId: IDS.position,
  assetsOut: "10.0224",
  assetDecimals: 6,
  blockingIssues: [],
};

export const EARN_WITHDRAWAL_TRANSACTION_REQUEST_EXAMPLE = {
  positionId: IDS.position,
  shares: "10",
};

export const EARN_WITHDRAWAL_TRANSACTION_EXAMPLE = {
  transaction: {
    transactionId: IDS.withdrawalBuild,
    transaction: UNSIGNED_TRANSACTION,
    lastValidBlockHeight: "361186972",
    sponsored: false,
    ownerAddress: OWNER,
    provider: "kamino",
    providerReference: VAULT,
    tokenMint: USDC_DEVNET,
    shareMint: SHARE_MINT,
    positionId: IDS.position,
    shares: "10",
    minAmountOut: null,
  },
} satisfies EarnExternalWalletWithdrawalTransactionResponse;

export const EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE = {
  transactionId: IDS.withdrawalBuild,
  signedTransaction: SIGNED_TRANSACTION,
};

/** A withdrawal submit's answer: `amount` is shares; the payout is not observed yet. */
export const EARN_WITHDRAWAL_SUBMIT_EXAMPLE = {
  movementId: IDS.withdrawalMovement,
  positionId: IDS.position,
  provider: "kamino",
  providerReference: VAULT,
  direction: "withdrawal",
  status: "submitted",
  settlement: "atomic",
  signature: SIGNATURE,
  ownerAddress: OWNER,
  amount: "10",
  denomination: SHARE_MINT,
  tokenMint: USDC_DEVNET,
  tokenAmount: null,
  failureReason: null,
  createdAt: "2026-11-06T18:21:04.120Z",
  confirmedAt: null,
  settledAt: null,
  replayed: false,
} satisfies EarnExternalWalletWithdrawalResponse["withdrawal"];

export const EARN_WITHDRAWAL_OPTIONS_REQUEST_EXAMPLE = { positionId: IDS.vedaPosition };

export const EARN_WITHDRAWAL_OPTIONS_EXAMPLE = {
  positionId: IDS.vedaPosition,
  instant: true,
  providerOrder: false,
  queued: true,
  withdrawAuthority: "11111111111111111111111111111111",
  queueState: "7XbSKzG8Kf1qsprNV1XE9YHNNpSV7jZBWLx1n4B6tSDf",
  queueAsset: {
    assetMint: USDC_DEVNET,
    allowWithdrawals: true,
    secondsToMaturity: 3600,
    minimumSecondsToDeadline: 60,
    maximumSecondsToDeadline: 7776000,
    minimumDiscountBps: 0,
    maximumDiscountBps: 100,
    minimumShares: "0.000001",
    shareDecimals: 6,
  },
  parRedemption: null,
} satisfies EarnVaultWithdrawalOptions;

/** One solver queue request: 15 shares at a 10 bps discount, fillable for 60 s. */
export const EARN_QUEUED_WITHDRAWAL_REQUEST_EXAMPLE = {
  positionId: IDS.vedaPosition,
  mechanism: "solverQueue",
  shares: "15",
  discountBps: 10,
  deadlineSeconds: 60,
} satisfies EarnVaultAsyncWithdrawalTermsRequest;

export const EARN_QUEUED_WITHDRAWAL_PREVIEW_EXAMPLE = {
  positionId: IDS.vedaPosition,
  assetMint: USDC_DEVNET,
  shares: "15",
  shareDecimals: 6,
  assets: "14.985",
  assetDecimals: 6,
  discountBps: 10,
  maturityTimestamp: "1793991049",
  deadlineTimestamp: "1793991109",
  blockingIssues: [],
} satisfies EarnVaultQueuedWithdrawalPreview;

const REQUEST_BUILD = {
  transaction: UNSIGNED_TRANSACTION,
  lastValidBlockHeight: "361187340",
  sponsored: false,
  ownerAddress: OWNER,
  provider: "veda",
  providerReference: VEDA_VAULT,
  tokenMint: USDC_DEVNET,
  shareMint: VEDA_SHARE_MINT,
  positionId: IDS.vedaPosition,
  requestAddress: REQUEST_ADDRESS,
};

export const EARN_WITHDRAWAL_REQUEST_TRANSACTION_EXAMPLE = {
  transaction: {
    transactionId: IDS.requestBuild,
    ...REQUEST_BUILD,
    action: "request",
    mechanism: "solverQueue",
    shares: "15",
    assets: "14.985",
    discountBps: 10,
    maturityTimestamp: "1793991049",
    deadlineTimestamp: "1793991109",
  },
} satisfies EarnExternalWalletWithdrawalRequestTransactionResponse;

export const EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE = {
  transactionId: IDS.requestBuild,
  signedTransaction: SIGNED_TRANSACTION,
};

export const EARN_CANCEL_TRANSACTION_REQUEST_EXAMPLE = {
  withdrawalRequestId: IDS.withdrawalRequest,
};

export const EARN_WITHDRAWAL_REQUEST_CANCEL_TRANSACTION_EXAMPLE = {
  transaction: {
    transactionId: IDS.cancelBuild,
    ...REQUEST_BUILD,
    withdrawalRequestId: IDS.withdrawalRequest,
    action: "cancel",
    mechanism: "solverQueue",
  },
} satisfies EarnExternalWalletWithdrawalRequestTransactionResponse;

export const EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE = {
  transactionId: IDS.cancelBuild,
  signedTransaction: SIGNED_TRANSACTION,
};

const PENDING_REQUEST = {
  withdrawalRequestId: IDS.withdrawalRequest,
  positionId: IDS.vedaPosition,
  provider: "veda",
  providerReference: VEDA_VAULT,
  ownerAddress: OWNER,
  requestAddress: REQUEST_ADDRESS,
  status: "pending",
  mechanism: "solverQueue",
  assetMint: USDC_DEVNET,
  shareMint: VEDA_SHARE_MINT,
  intermediateMint: null,
  intermediateAmount: null,
  shares: "15",
  quotedAssets: "14.985",
  shareDecimals: 6,
  assetDecimals: 6,
  discountBps: 10,
  nonce: "0",
  creationTimestamp: "1793987449",
  maturityTimestamp: "1793991049",
  deadlineTimestamp: "1793991109",
  creationSignature: SIGNATURE,
  cancelSignature: null,
  closingSignature: null,
  assetsPaid: null,
  failureReason: null,
  fulfilledAt: null,
  cancelledAt: null,
  createdAt: "2026-11-06T18:10:18.900Z",
  updatedAt: "2026-11-06T18:26:00.379Z",
} satisfies EarnVaultWithdrawalRequestRecord;

/** A solver queue request waiting for maturity: shares are escrowed, nothing is paid. */
export const EARN_WITHDRAWAL_REQUEST_EXAMPLE = {
  withdrawalRequest: PENDING_REQUEST,
} satisfies EarnVaultWithdrawalRequestResponse;

/** The same request after its cancellation was submitted past the deadline. */
export const EARN_WITHDRAWAL_REQUEST_CANCELLING_EXAMPLE = {
  withdrawalRequest: {
    ...PENDING_REQUEST,
    status: "cancelling",
    cancelSignature:
      "q7g4PK7KtYN8aUWuWL3VAGeecsLWdS4KeSPVpL5YJGLHt5HAz5Ajgr9pwFWTTfK4dh6XjCjuCp3gdex678CPU8h",
    updatedAt: "2026-11-06T19:12:41.020Z",
  },
} satisfies EarnVaultWithdrawalRequestResponse;

export const EARN_WITHDRAWAL_REQUESTS_EXAMPLE = {
  withdrawalRequests: [PENDING_REQUEST],
  hasMore: false,
  nextCursor: null,
} satisfies EarnVaultWithdrawalRequestsPage;
