import type {
  EarnApyType,
  EarnDepositTokenSymbol,
  EarnLiquidityTerm,
  EarnPortfolioAllocationInput,
  EarnPortfolioDepositsPage,
  EarnPortfolioTargetAllocations,
  EarnPortfolioToken,
  EarnPortfolioWalletSnapshot,
  EarnPortfolioWalletStatus,
  EarnPortfolioWithdrawal,
  EarnPortfolioWithdrawalPreview,
  EarnPortfolioYield,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  SdpEnvironment,
  SolanaCluster,
} from "@sdp/types";
import type { EarnProviderId } from "@sdp/types/provider-access";

/**
 * Runtime context for catalogue/quote/execute calls. Providers read their own
 * credentials from `env` keyed by `environment`; the route handler resolves
 * `environment` (it depends on AppContext) and passes plain values so the
 * provider stays AppContext-free. Same shape as `RampRuntimeContext` in
 * @sdp/payments, but named `environment` to match the rest of Earn.
 */
export interface EarnRuntimeEnvironment {
  GROUND_API_KEY?: string;
  GROUND_SANDBOX_API_KEY?: string;
  SOLANA_RPC_URL?: string;
}

export interface EarnRuntimeContext {
  env: EarnRuntimeEnvironment;
  environment: SdpEnvironment;
}

/**
 * Static support a provider declares up front (before any live call): which
 * stablecoin symbols it can take deposits in and which strategy shapes it
 * fronts. Consumed by catalogue-sync validation — a snapshot reported by
 * `listStrategies` that falls outside this envelope is provider drift, not a
 * strategy to persist (see `isStrategyWithinDeclaredSupport`). Declared in
 * symbols, not mints, because the declaration is cluster-agnostic; the
 * helper bridges to the mint addresses the runtime speaks. Unlike ramp rail
 * support there is no committed dump/distill snapshot for Earn yet.
 */
export interface EarnDeclaredStrategySupport {
  sourceKinds: readonly EarnStrategySourceKind[];
  depositTokens: readonly EarnDepositTokenSymbol[];
}

/** Live catalogue row as reported by the provider, pre-persistence. */
export interface ProviderStrategySnapshot {
  providerReference: string;
  name: string;
  sourceKind: EarnStrategySourceKind;
  underlyingSource?: string;
  depositMints: string[];
  shareMint?: string;
  apyType: EarnApyType;
  currentApy?: string;
  liquidityTerm: EarnLiquidityTerm;
  redemptionDelayDays?: number;
  riskMetadata?: EarnStrategyRiskMetadata;
  /**
   * The cluster this strategy's instrument lives on. REQUIRED — every provider
   * must state it rather than let the sync assume the environment's own
   * cluster, because that assumption is exactly what a single-cluster provider
   * catalogued into the wrong environment would violate silently (see
   * `EarnStrategy` in @sdp/types). Ground answers with its environment's
   * cluster. Kamino answers per data source: `mainnet-beta` from the REST shelf
   * in production, `devnet` from the on-chain read elsewhere — and that second
   * one is measured (genesis hash) rather than inferred from the environment,
   * which is the whole point of this field.
   */
  hostCluster: SolanaCluster;
}

/**
 * Base vault-infra provider contract: the catalogue, and nothing speculative.
 * Every member is real and called (V1 is portfolio-only — per-strategy
 * quote/execution seams live in git history until PRO-1634 gives them a
 * consumer). All HTTP lives behind this; the route handler owns DB interaction
 * and passes pre-resolved inputs. Optional surfaces are capability extensions
 * (see EarnPortfolioWalletProvider / EarnWithdrawalApprovalProvider) detected
 * by method presence in capabilities.ts — never provider-id checks.
 */
export interface EarnVaultProvider {
  provider: EarnProviderId;
  declaredSupport: EarnDeclaredStrategySupport;
  /** Live strategy catalogue; synced into `earn_strategies` by the API. */
  listStrategies(ctx: EarnRuntimeContext): Promise<ProviderStrategySnapshot[]>;
}

/**
 * The volatile half of a catalogue row: the numbers that move on their own
 * between syncs. Deliberately NOT a whole snapshot — a refresh may only update
 * figures, never a strategy's identity, mints, or liquidity terms, so nothing
 * on this shape can admit a vault the catalogue gate would refuse.
 */
export interface ProviderStrategyMetrics {
  /** Must match a `providerReference` the catalogue already holds. */
  providerReference: string;
  /** Latest APY as a decimal string; omitted when the provider has no rate. */
  currentApy?: string;
  /**
   * Volatile risk-metadata figures (TVL, holders, utilization). MERGED over the
   * stored metadata rather than replacing it, so slow-moving fields the
   * catalogue sync owns — curator above all — survive a refresh that does not
   * report them.
   */
  riskMetadata?: EarnStrategyRiskMetadata;
}

/**
 * Optional capability: rates fresh enough to quote.
 *
 * The catalogue sync runs hourly because catalogue DRIFT is slow — a provider
 * onboarding or delisting a vault. Rates are not slow, and an hour-old APY on a
 * comparison table is a number a customer could act on wrongly. A provider that
 * can serve its whole shelf's live figures in a call or two implements this,
 * and a short-cadence pass refreshes only those figures in place.
 *
 * Why a write pass and not a live read at request time: the strategies route
 * reads exactly ONE source for the state it reports (ADR 0002 addendum), and
 * overlaying live numbers onto DB rows at read time would blend two. Freshness
 * comes from cadence instead, so the route stays a plain DB read and every
 * consumer — API, dashboard, a partner's own cache — sees the same figures.
 *
 * Discovered via `supportsLiveMetrics` (capabilities.ts), never provider-id
 * checks. A provider that would need one request per vault should NOT implement
 * this; the pass would cost more than the staleness it removes.
 */
export interface EarnLiveMetricsProvider extends EarnVaultProvider {
  /**
   * Current figures for every strategy this provider lists. Returning a
   * reference the catalogue does not hold is harmless — the refresh updates
   * existing rows and never inserts.
   */
  listStrategyMetrics(ctx: EarnRuntimeContext): Promise<ProviderStrategyMetrics[]>;
}

export interface EarnPortfolioWalletCreateInput {
  label: string;
  allocations: EarnPortfolioAllocationInput;
  /**
   * Idempotency key (UUIDv4), REQUIRED since PRO-1670 — the same reason the
   * withdrawal input requires one. Until then an organization held at most one
   * program per (environment, provider) and a DB unique constraint caught a
   * retried create; with N programs legal, nothing downstream can tell a retry
   * from a genuine second program, so the key is the ONLY defence against
   * provisioning a duplicate wallet the customer may then fund.
   */
  requestId: string;
}

export interface EarnPortfolioWalletCreateResult {
  providerWalletRef: string;
  status: EarnPortfolioWalletStatus;
}

export interface EarnPortfolioWalletRefInput {
  providerWalletRef: string;
}

export interface EarnPortfolioStrategyUpdateInput {
  providerWalletRef: string;
  allocations: EarnPortfolioAllocationInput;
  /** Idempotency key (UUIDv4) forwarded to the provider; generated when omitted. */
  requestId?: string;
}

export interface EarnPortfolioStrategyUpdateResult {
  /** Provider-confirmed weights the wallet will rebalance toward. */
  allocations: EarnPortfolioTargetAllocations;
}

export interface EarnPortfolioDepositsInput {
  providerWalletRef: string;
  cursor?: string;
}

export interface EarnPortfolioWithdrawalPreviewInput {
  providerWalletRef: string;
  /**
   * USD amount as a decimal string. OPTIONAL: omit it to ask the provider what
   * the lane can pay right now, which is the preview's liquidity-read form
   * (PRO-1675). With an amount the preview also validates feasibility; without
   * one it answers `withdrawableUsd` alone and leaves `amountRequestedUsd`
   * unset. A provider must OMIT the field from its wire call when absent —
   * never substitute `0`, which asks a different question.
   */
  amountUsd?: string;
  token: EarnPortfolioToken;
}

export interface EarnPortfolioWithdrawalCreateInput {
  providerWalletRef: string;
  /**
   * Idempotency key (UUIDv4), REQUIRED here unlike the create/update inputs:
   * a withdrawal retry without a stable key can double-send funds, so the
   * caller (which owns the retry loop) must own the key.
   */
  requestId: string;
  /** USD amount as a decimal string. */
  amountUsd: string;
  token: EarnPortfolioToken;
  /** Solana address for this environment's cluster — the only rail SDP surfaces. */
  destinationAddress: string;
}

export interface EarnPortfolioWithdrawalStatusInput {
  providerWalletRef: string;
  withdrawalRef: string;
}

export interface EarnPortfolioAddressBookEntryInput {
  /** Solana address to whitelist as a withdrawal destination. */
  address: string;
  label: string;
}

export interface EarnPortfolioAddressBookEntryResult {
  entryRef: string;
}

export type EarnWithdrawalApprovalAction = "approve" | "reject";

/**
 * One provider-side signing activity parked on customer approval, joined with
 * whatever withdrawal context the provider reports. `providerStatus` and
 * `kind` are provider vocabulary passed through open. The destination fields
 * are provider plumbing that may name non-Solana rails — they exist for
 * operator correlation and must be re-synthesized before ever reaching wire
 * types or UI (ADR 0002 invariant 5).
 */
export interface EarnPendingWithdrawalApproval {
  approvalRef: string;
  providerStatus: string;
  kind?: string;
  withdrawalRef?: string;
  withdrawalLegRef?: string;
  providerWalletRef?: string;
  destinationChain?: string;
  destinationToken?: string;
  destinationAddress?: string;
  amountNativeUnits?: string;
  firstSeenAt?: string;
}

export interface EarnWithdrawalApprovalRequestInput {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
}

/**
 * The payload the customer's signer must stamp. `signingPayload` is the exact
 * string to sign, byte-for-byte — re-serializing `providerRequest` can reorder
 * keys and invalidate the signature. `providerRequest` is echoed unmodified
 * into the vote submission so the provider can verify what was signed.
 */
export interface EarnWithdrawalApprovalRequest {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
  signingPayload: string;
  providerRequest: Record<string, unknown>;
}

/**
 * Signature produced by the customer's signer, outside SDP and outside the
 * provider. Either an opaque string or a header pair, matching the shapes
 * signer SDKs emit.
 */
export type EarnWithdrawalApprovalStamp = string | { headerName: string; headerValue: string };

export interface EarnWithdrawalApprovalVoteInput {
  approvalRef: string;
  action: EarnWithdrawalApprovalAction;
  stamp: EarnWithdrawalApprovalStamp;
  /** The untouched `providerRequest` from `createWithdrawalApprovalRequest`. */
  providerRequest: Record<string, unknown>;
}

export interface EarnWithdrawalApprovalVoteResult {
  action: EarnWithdrawalApprovalAction;
  /** The provider recorded this vote. */
  applied: boolean;
  /** The activity had already reached a terminal state before this vote. */
  alreadyResolved: boolean;
  providerStatus?: string;
}

/**
 * Optional capability: managed portfolio wallets (one omnibus wallet whose
 * funds spread across yield sources by a target strategy). Declared the same
 * way ramp providers declare optional operations — a provider opts in by
 * implementing the methods, and callers discover it via
 * `supportsPortfolioWallets` (see capabilities.ts) instead of dispatching on
 * provider ids, so the next portfolio provider is a client change only.
 * Chain rails are implicit: SDP is Solana-only, so deposit addresses and
 * withdrawal destinations always ride the environment's Solana cluster.
 */
export interface EarnPortfolioWalletProvider extends EarnVaultProvider {
  createPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletCreateInput
  ): Promise<EarnPortfolioWalletCreateResult>;
  getPortfolioWallet(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioWalletSnapshot>;
  updatePortfolioStrategy(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioStrategyUpdateInput
  ): Promise<EarnPortfolioStrategyUpdateResult>;
  /**
   * Yield metrics for the program (earned to date + the blended current rate).
   * Separate from `getPortfolioWallet` because providers serve it from a
   * distinct endpoint; callers that only need balances must not pay for it.
   */
  getPortfolioYield(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWalletRefInput
  ): Promise<EarnPortfolioYield>;
  listPortfolioDeposits(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioDepositsInput
  ): Promise<EarnPortfolioDepositsPage>;
  previewPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalPreviewInput
  ): Promise<EarnPortfolioWithdrawalPreview>;
  createPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalCreateInput
  ): Promise<EarnPortfolioWithdrawal>;
  getPortfolioWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioWithdrawalStatusInput
  ): Promise<EarnPortfolioWithdrawal>;
  /**
   * Whitelist a withdrawal destination in the provider's address book.
   * Providers may enforce (or later enable) destination whitelisting; exposing
   * it on the contract lets the API pre-register destinations instead of
   * folding an implicit write into the withdrawal flow.
   */
  createPortfolioAddressBookEntry(
    ctx: EarnRuntimeContext,
    input: EarnPortfolioAddressBookEntryInput
  ): Promise<EarnPortfolioAddressBookEntryResult>;
}

/**
 * One account slot in a built instruction.
 *
 * `role` mirrors `@solana/kit`'s `AccountRole` numeric enum (0 readonly,
 * 1 writable, 2 readonly-signer, 3 writable-signer) WITHOUT importing it: this
 * package's single dependency is `@sdp/types`, and taking `@solana/kit` here
 * would put a chain SDK inside the hourly catalogue cron. The numbers are the
 * wire format, and the provider client re-labels them at its own boundary.
 */
export interface EarnVaultAccountRef {
  address: string;
  role: number;
}

/** One built instruction, as plain data. `data` is base64. */
export interface EarnVaultInstruction {
  programAddress: string;
  accounts: EarnVaultAccountRef[];
  data: string;
}

/**
 * Unsigned work for a non-custodial vault, ready for the API to compile.
 *
 * `instructions` is one complete transaction. Vault execution rejects final
 * signed bytes that exceed Solana's packet limit.
 */
export interface EarnVaultTransactionPlan {
  cluster: SolanaCluster;
  instructions: EarnVaultInstruction[];
  /** Address lookup tables the caller should apply when compiling. */
  lookupTables: string[];
  /**
   * Asset addresses observed from the live vault state used to build this plan.
   *
   * Required so the execution layer can compare builder truth with catalogue
   * metadata before signing. Amount validation alone is insufficient: a stale
   * or poisoned catalogue row could otherwise apply policy and ledger labels to
   * one mint while the instructions actually move another.
   */
  assetIdentity: EarnVaultAssetIdentity;
  /**
   * The amounts the instructions above actually ENCODE, canonical to each
   * mint's own precision.
   *
   * Separate from the request because they need not be the same number: a chain
   * SDK converts decimals to mint atoms and typically FLOORS, so a request of
   * `1.0000009` against a six-decimal mint encodes `1.000000`. A provider that
   * refuses over-precise input (the right answer) still re-serialises here, so
   * `"1.500"` returns as `"1.5"`. Ledger these rather than the raw request: only
   * the builder knows the mint's decimals, and a movement row is a claim about
   * what moved on chain.
   */
  accepted?: EarnVaultAcceptedAmounts;
  /**
   * True when these instructions CREATE the owner's share token account, so its
   * rent-exemption is charged to `rentPayer` on this transaction.
   *
   * Reported rather than assumed. Account creation is idempotent, so the
   * presence of a create instruction proves nothing: a plan for an owner who
   * already holds the account emits the same instruction and pays no rent. Only
   * the builder, which read the chain, can say which happened, and the caller
   * needs to know because it must remember who to give the rent back to when
   * the account is closed. Absent or false means no rent was charged here.
   *
   * KNOWN RESIDUAL: this is a pre-execution read, so it can be wrong in BOTH
   * directions if chain state moves between the read and the broadcast. True
   * when no rent was charged (someone else created the account first), and false
   * when rent WAS charged (the account was closed in between, so the idempotent
   * create fires for real and nothing records it). Either way one ATA's rent,
   * 2,039,280 lamports, is later credited to a party that did not pay it, and
   * only on a full exit.
   *
   * Concurrency does not make this safe: the fee mode is per PROCESS, so a
   * rolling deploy has both answers live at once, and a create from outside SDP
   * needs no concurrency at all. A claim whose transaction never lands does NOT
   * persist, though: the attribution is a ledger projection that drops a failed
   * movement's claim (SDP migration 0067), so this residual is bounded by the
   * build-to-broadcast window plus reconciliation lag, not by the position's
   * lifetime.
   *
   * Closing it entirely needs the funder confirmed from the LANDED transaction
   * at settlement rather than predicted at build; that is deliberately not in
   * this change.
   */
  createsShareAccount?: boolean;
}

/** Solana asset identity bound to an unsigned vault transaction plan. */
export interface EarnVaultAssetIdentity {
  /** Mint whose tokens the deposit instructions consume. */
  depositTokenMint: string;
  /** Mint whose receipt/share tokens the vault issues. */
  shareMint: string;
}

/** What a built plan encodes, per mint. All values are decimal strings. */
export interface EarnVaultAcceptedAmounts {
  amount?: string;
  minSharesOut?: string;
  shares?: string;
  /** Withdrawal slippage floor, in the deposit token's own units. */
  minAmountOut?: string;
}

export interface EarnVaultDepositInput {
  /** Vault address — the strategy's `providerReference`. */
  providerReference: string;
  /** Address whose tokens move and whose shares are minted. */
  owner: string;
  /** Deposit amount in the vault token's own units, as a decimal string. */
  amount: string;
  /** Minimum shares to accept, as a decimal string — slippage floor. */
  minSharesOut?: string;
  /**
   * Who funds rent for any account this plan must create, typically the share
   * ATA a first deposit needs.
   *
   * NOT the transaction fee payer. A provider SDK embeds this account INSIDE
   * the instruction accounts as writable+signer, so whoever is named here pays
   * a real, separate cost; the fee payer is set when SDP compiles the message.
   * Omitted means the `owner` funds it, which is what an owner-paid deposit
   * wants. SDP names an address here only when someone else pays: its Kora
   * sponsor under sponsorship, or the partner's caller-provided fee payer on
   * the external-wallet builds — and then the SAME address is also the fee
   * payer, so one extra signature covers both roles. See
   * docs/decisions/0002-earn-provider-pluggability.md.
   */
  rentPayer?: string;
}

export interface EarnVaultWithdrawInput {
  providerReference: string;
  owner: string;
  /** Shares to redeem, as a decimal string. */
  shares: string;
  /**
   * Where to send rent reclaimed by closing accounts this exit empties, when it
   * empties them. Omitted means the `owner` keeps it.
   *
   * The caller supplies the address it RECORDED when the account was created,
   * never a currently-configured sponsor: whoever funded the rent is a fact
   * about the deposit, and refunding anyone else moves lamports away from the
   * party that actually paid. A provider that empties no closable account
   * ignores this.
   */
  rentRefundTo?: string;
  /**
   * Who funds rent for any account this plan must create, typically the share
   * ATA a first deposit needs.
   *
   * NOT the transaction fee payer. A provider SDK embeds this account INSIDE
   * the instruction accounts as writable+signer, so whoever is named here pays
   * a real, separate cost; the fee payer is set when SDP compiles the message.
   * Omitted means the `owner` funds it, which is what an owner-paid deposit
   * wants. SDP names an address here only when someone else pays: its Kora
   * sponsor under sponsorship, or the partner's caller-provided fee payer on
   * the external-wallet builds — and then the SAME address is also the fee
   * payer, so one extra signature covers both roles. See
   * docs/decisions/0002-earn-provider-pluggability.md.
   */
  rentPayer?: string;
  /**
   * Minimum deposit-token amount to accept for those shares — the exit's
   * slippage floor, in the deposit token's own units. Optional on the
   * contract; a provider whose builder refuses an implicit tolerance (Veda)
   * refuses its absence with a typed error rather than inventing one.
   */
  minAmountOut?: string;
}

export interface EarnVaultWithdrawQuoteInput {
  /** Vault address — the position's `providerReference`. */
  providerReference: string;
  /** Shares to redeem, as a decimal string. */
  shares: string;
}

/**
 * One provider's answer to "what would redeeming these shares pay right now".
 * The exit twin of `EarnVaultDepositQuote`, and used the same way: a caller
 * derives a truthful `minAmountOut` floor from `assetsOut` minus a chosen
 * tolerance, so the floor tracks the LIVE rate instead of assuming one.
 */
export interface EarnVaultWithdrawQuote {
  /** Deposit-token amount at the live rate, decimal string at token scale. */
  assetsOut: string;
  /** The deposit token's decimals — the scale a floor must be quantized to. */
  assetDecimals: number;
  /** Conditions the provider reports would block this exit, empty when none. */
  blockingIssues: readonly EarnVaultDepositQuoteIssue[];
}

export interface EarnVaultDepositQuoteInput {
  /** Vault address — the strategy's `providerReference`. */
  providerReference: string;
  /** Deposit amount in the vault token's own units, as a decimal string. */
  amount: string;
}

/** A provider-reported condition that would block the quoted deposit. */
export interface EarnVaultDepositQuoteIssue {
  /** The provider's own stable code (e.g. `TELLER_PAUSED`), passed through. */
  code: string;
  /** The provider's own sentence for it. */
  message: string;
}

/**
 * One provider's answer to "what would this deposit mint right now".
 *
 * A quote is a READ: it applies the vault's live exchange rate, fees and caps
 * to an amount and commits to nothing. Its purpose is to let a caller derive a
 * truthful `minSharesOut` floor — `sharesOut` minus a chosen tolerance — so
 * the floor tracks the LIVE rate instead of assuming one. The tolerance then
 * covers only what it honestly can: the state moving between this quote and
 * the transaction landing.
 */
export interface EarnVaultDepositQuote {
  /** Shares the vault would mint right now, decimal string at share scale. */
  sharesOut: string;
  /** The share mint's decimals — the scale a floor must be quantized to. */
  shareDecimals: number;
  /**
   * Conditions the provider reports would block this deposit, empty when none.
   * Reported rather than thrown: "the vault is paused" is an answer about the
   * vault, not a failure to answer.
   */
  blockingIssues: readonly EarnVaultDepositQuoteIssue[];
}

export interface EarnVaultPositionInput {
  owner: string;
  /** Vault addresses to read. Empty means every owner-held vault the provider can discover. */
  providerReferences: readonly string[];
}

/** One owner's live holding in one vault. All amounts are decimal strings. */
export interface EarnVaultPositionSnapshot {
  providerReference: string;
  owner: string;
  cluster: SolanaCluster;
  shares: string;
  /** Unstaked shares the provider can redeem immediately. */
  withdrawableShares: string;
  /** Value of those shares in the deposit token; omitted when unreadable. */
  tokenValue?: string;
  tokenMint: string;
  shareMint: string;
}

/**
 * Optional capability: NON-CUSTODIAL vaults the customer's own wallet deposits
 * into (Kamino's K-Vaults; `earnDepositStyle` calls these `vault_direct`).
 *
 * The shape difference from `EarnPortfolioWalletProvider` is the whole point.
 * A portfolio provider CUSTODIES: SDP asks it to provision a wallet and the
 * customer funds that address. A vault-direct provider custodies nothing —
 * there is no address to send to, and stablecoins sent to the vault's program
 * account are LOST. Money moves only when a wallet SDP can sign for submits an
 * instruction, so this capability builds unsigned plans and SDP's own custody
 * and signing services do the rest.
 *
 * Everything crossing this contract is plain data (see the types above), so a
 * provider client may speak whatever chain SDK it likes without that SDK
 * reaching this package. Discovered via `supportsVaultDirect` (capabilities.ts),
 * never provider-id checks.
 */
export interface EarnVaultDirectProvider extends EarnVaultProvider {
  buildVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositInput
  ): Promise<EarnVaultTransactionPlan>;
  /**
   * Live positions. Read from chain per call and never persisted — positions are
   * provider truth (ADR 0002), and for a vault-direct provider "the provider" is
   * the chain itself.
   */
  readVaultPositions(
    ctx: EarnRuntimeContext,
    input: EarnVaultPositionInput
  ): Promise<EarnVaultPositionSnapshot[]>;
  /**
   * Every on-chain program this client may emit an instruction for on
   * `cluster`, as plain base58 strings.
   *
   * Exists so sponsorship is inheritable rather than bespoke. A sponsored
   * transaction is rejected outright by the paymaster unless every program it
   * touches is allowlisted in the paymaster's own config, which lives in
   * another repository and cannot import this one. Declaring the set HERE, next
   * to the code that emits the instructions, lets an allowlist be asserted a
   * superset of every provider's declaration: the local harness config on every
   * CI run, and the deployed config through the live Kora smoke suite. A new
   * provider is covered by both the moment it implements this method, so a
   * forgotten allowlist entry surfaces in a test rather than in a customer's
   * first deposit.
   *
   * Synchronous and pure: this is a static declaration about code, never a
   * chain read. Cluster-parameterised because a program id may differ per
   * cluster, and naming the other cluster's id is a silent-failure class of its
   * own (see @sdp/types/kamino-programs).
   */
  sponsoredPrograms(cluster: SolanaCluster): readonly string[];
}

/**
 * Optional capability: the money-OUT half of the vault-direct model, kept
 * SEPARATE from money-in deliberately.
 *
 * Splitting it is not taxonomy for its own sake. Deposit and withdrawal are
 * independent provider capabilities: supporting money in does not prove that a
 * client can construct, validate, and safely price the provider's exit path.
 *
 * Discovered via `supportsVaultWithdraw` (capabilities.ts). A provider may
 * implement `EarnVaultDirectProvider` alone, and an exit route must then refuse
 * rather than assume. Note this says only whether the ROUTE CAN BE BUILT — it is
 * never a permission gate, because ADR 0002 forbids money-out inheriting any
 * money-in gate.
 */
export interface EarnVaultWithdrawProvider extends EarnVaultDirectProvider {
  buildVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawInput
  ): Promise<EarnVaultTransactionPlan>;
}

/**
 * Optional capability: a live deposit quote (see `EarnVaultDepositQuote`).
 *
 * Separate from `EarnVaultDirectProvider` because a quote is a promise about
 * the provider's READ surface, not implied by being able to build a deposit —
 * and separate from the floor REQUIREMENT, which the deposit builder itself
 * enforces. A provider that requires a floor should implement this so callers
 * can derive one from the live rate rather than guessing.
 */
export interface EarnVaultDepositQuoteProvider extends EarnVaultDirectProvider {
  quoteVaultDeposit(
    ctx: EarnRuntimeContext,
    input: EarnVaultDepositQuoteInput
  ): Promise<EarnVaultDepositQuote>;
}

/**
 * Optional capability: a live withdrawal quote (see `EarnVaultWithdrawQuote`).
 * Extends the WITHDRAW capability, not the deposit-quote one: an exit quote
 * exists to derive an exit floor, and it means nothing on a provider whose
 * exit SDP cannot carry.
 */
export interface EarnVaultWithdrawQuoteProvider extends EarnVaultWithdrawProvider {
  quoteVaultWithdrawal(
    ctx: EarnRuntimeContext,
    input: EarnVaultWithdrawQuoteInput
  ): Promise<EarnVaultWithdrawQuote>;
}

/**
 * Optional capability: customer-approval flows for withdrawal payouts. Some
 * providers gate payout legs on a customer-side signature (Ground: Turnkey
 * consensus voting, engaged by an org-level approval policy rather than by
 * default). SDP relays the provider's signing payload and the customer's
 * stamp; the signing key itself never enters SDP — if no signer is available,
 * this capability surfaces the parked state but cannot advance it. Discovered
 * via `supportsWithdrawalApprovals` (capabilities.ts), never provider-id
 * checks.
 */
export interface EarnWithdrawalApprovalProvider extends EarnVaultProvider {
  listPendingWithdrawalApprovals(ctx: EarnRuntimeContext): Promise<EarnPendingWithdrawalApproval[]>;
  createWithdrawalApprovalRequest(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalRequestInput
  ): Promise<EarnWithdrawalApprovalRequest>;
  submitWithdrawalApprovalVote(
    ctx: EarnRuntimeContext,
    input: EarnWithdrawalApprovalVoteInput
  ): Promise<EarnWithdrawalApprovalVoteResult>;
}
