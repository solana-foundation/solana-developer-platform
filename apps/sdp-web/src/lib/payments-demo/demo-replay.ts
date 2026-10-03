import {
  type Counterparty,
  type CounterpartyAccount,
  isCountryCode,
  type PaymentRampQuoteDeliveryMode,
  type PaymentRecurringPayment,
  type PaymentTransferRecipient,
  type RampProviderId,
} from "@sdp/types";
import {
  CREATED_BY,
  DEMO_TOKENS,
  type DemoTokenKey,
  type DemoTransfer,
  type DemoWallet,
  type DemoWorld,
  demoAddress,
  demoSignature,
  findWallet,
  fromBaseUnits,
  HOUR_MS,
  newestFirst,
  ORGANIZATION_ID,
  PROJECT_ID,
  toBaseUnits,
  tokenBalance,
} from "./demo-fixtures";
import type { DemoOp, DemoOpOf } from "./demo-ops";
import { isDemoRampRail, railAsset } from "./demo-ramp-assets";

/*
 * The session's actions applied to the fixture world, oldest first. Each one changes the world
 * the way the real API would have: a payment lists in Transactions and lowers the wallet's
 * balance, a schedule activates, a contact gains an address. An action whose subject is gone
 * (the session dropped it for space, or it was archived) changes nothing.
 */

/** How long after its pay-in a ramp shows as settling before it completes. */
export const DEMO_SETTLE_MS = 5_000;
/** Recipients per transaction in a demo batch, as the API packs them. */
export const DEMO_BATCH_RECIPIENTS_PER_TRANSACTION = 8;

const DECIMAL = /^\d+(\.\d+)?$/;

function iso(at: number): string {
  return new Date(at).toISOString();
}

export function tokenKeyForMint(mint: string): DemoTokenKey | undefined {
  return (Object.keys(DEMO_TOKENS) as DemoTokenKey[]).find((key) => DEMO_TOKENS[key].mint === mint);
}

/**
 * The demo token a ramp's asset rail delivers ("usdc.solana" → USDC), or undefined for an asset
 * the demo wallets don't hold: such a ramp is refused, never run in USDC instead.
 */
export function tokenKeyForRail(rail: string): DemoTokenKey | undefined {
  if (!isDemoRampRail(rail)) return undefined;
  const asset = railAsset(rail);
  return (Object.keys(DEMO_TOKENS) as DemoTokenKey[]).find(
    (candidate) => DEMO_TOKENS[candidate].symbol.toLowerCase() === asset
  );
}

export function contactById(world: DemoWorld, id: string | null | undefined) {
  return Object.values(world.contacts).find((contact) => contact.id === id);
}

export function accountById(world: DemoWorld, id: string | null | undefined) {
  return Object.values(world.accounts).find((account) => account.id === id);
}

function contactKeyOf(world: DemoWorld, id: string): string | undefined {
  return Object.keys(world.contacts).find((key) => world.contacts[key]?.id === id);
}

export function transferById(world: DemoWorld, id: string): DemoTransfer | undefined {
  return world.transfers.find((row) => row.transfer.id === id)?.transfer;
}

/** A wallet's holding of a token, in display units ("0" when it holds none). */
export function walletHolding(wallet: DemoWallet, mint: string): string {
  return wallet.balances.find((balance) => balance.mint === mint)?.uiAmount ?? "0";
}

function adjustBalance(
  world: DemoWorld,
  walletId: string,
  mint: string,
  amount: string,
  sign: 1 | -1
): void {
  const wallet = findWallet(world, walletId);
  const key = tokenKeyForMint(mint);
  if (!wallet || !key || !DECIMAL.test(amount)) return;
  const { decimals } = DEMO_TOKENS[key];
  const index = wallet.balances.findIndex((balance) => balance.mint === mint);
  const current = index === -1 ? 0n : BigInt(wallet.balances[index]?.amount ?? "0");
  const next = current + BigInt(sign) * toBaseUnits(amount, decimals);
  const balance = tokenBalance(key, fromBaseUnits(next < 0n ? 0n : next, decimals));
  if (index === -1) wallet.balances.push(balance);
  else wallet.balances[index] = balance;
}

function outboundTransfer(
  id: string,
  at: number,
  wallet: DemoWallet,
  fields: Partial<DemoTransfer>
): DemoTransfer {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    custodyWalletId: wallet.id,
    providerWalletId: wallet.walletId,
    type: "transfer",
    kind: "pay",
    direction: "outbound",
    status: "finalized",
    signature: demoSignature(id),
    error: null,
    source: wallet.publicKey,
    rampsMemo: {},
    createdAt: iso(at),
    updatedAt: iso(at + 2_000),
    ...fields,
  };
}

function withContact(contact: Counterparty | undefined): Partial<DemoTransfer> {
  return contact
    ? { counterpartyId: contact.id, counterpartyDisplayName: contact.displayName }
    : {};
}

function applyContact(world: DemoWorld, op: DemoOpOf<"contact">): void {
  world.contacts[op.id] = {
    id: op.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    externalId: op.ext,
    entityType: op.entity,
    displayName: op.name,
    status: "active",
    createdBy: CREATED_BY,
    createdAt: iso(op.at),
    updatedAt: iso(op.at),
  };
}

function applyContactArchive(world: DemoWorld, op: DemoOpOf<"contact-archive">): void {
  const key = contactKeyOf(world, op.id);
  if (key === undefined) return;
  delete world.contacts[key];
  for (const [accountKey, account] of Object.entries(world.accounts)) {
    if (account.counterpartyId === op.id) delete world.accounts[accountKey];
  }
}

function applyAddress(world: DemoWorld, op: DemoOpOf<"address">): void {
  if (!contactById(world, op.cp)) return;
  const account: CounterpartyAccount = {
    id: op.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    counterpartyId: op.cp,
    accountKind: "crypto_wallet",
    label: op.label,
    details: { network: "solana", address: op.address },
    providerAccountData: {},
    status: "active",
    createdAt: iso(op.at),
    updatedAt: iso(op.at),
  };
  world.accounts[op.id] = account;
}

function applySend(world: DemoWorld, op: DemoOpOf<"send">): void {
  const wallet = findWallet(world, op.wallet);
  if (!wallet) return;
  const account = Object.values(world.accounts).find(
    (candidate) => candidate.details.address === op.to
  );
  world.transfers.push({
    transfer: outboundTransfer(op.id, op.at, wallet, {
      destination: op.to,
      token: op.token,
      amount: op.amount,
      ...(op.memo ? { memo: op.memo } : {}),
      ...withContact(contactById(world, account?.counterpartyId)),
    }),
    observed: false,
  });
  adjustBalance(world, wallet.id, op.token, op.amount, -1);
}

function sum(amounts: readonly string[], mint: string): string {
  const key = tokenKeyForMint(mint) ?? "USDC";
  const { decimals } = DEMO_TOKENS[key];
  const total = amounts.reduce(
    (running, amount) => running + (DECIMAL.test(amount) ? toBaseUnits(amount, decimals) : 0n),
    0n
  );
  return fromBaseUnits(total, decimals, 2);
}

function applyBatch(world: DemoWorld, op: DemoOpOf<"batch">): void {
  const wallet = findWallet(world, op.wallet);
  if (!wallet) return;
  const createdAt = iso(op.at);
  const recipients: PaymentTransferRecipient[] = [];
  const chunks: (typeof op.to)[] = [];
  for (let index = 0; index < op.to.length; index += DEMO_BATCH_RECIPIENTS_PER_TRANSACTION) {
    chunks.push(op.to.slice(index, index + DEMO_BATCH_RECIPIENTS_PER_TRANSACTION));
  }
  chunks.forEach((chunk, chunkIndex) => {
    const transferId = `${op.id}_${chunkIndex + 1}`;
    world.transfers.push({
      transfer: outboundTransfer(transferId, op.at + chunkIndex, wallet, {
        type: "transfer_batch",
        kind: "batch_pay",
        token: op.token,
        amount: sum(
          chunk.map(([, , amount]) => amount),
          op.token
        ),
      }),
      observed: false,
    });
    for (const [counterpartyId, accountId, amount] of chunk) {
      recipients.push({
        id: `${op.id}_r${recipients.length + 1}`,
        batchId: op.id,
        transferId,
        externalId: op.ext ? `${op.ext}-${String(recipients.length + 1).padStart(3, "0")}` : null,
        counterpartyId,
        counterpartyAccountId: accountId,
        destination: accountById(world, accountId)?.details.address ?? demoAddress(accountId),
        amount,
        status: "confirmed",
        error: null,
        createdAt,
        updatedAt: iso(op.at + 2_000),
      });
    }
  });
  const totalAmount = sum(
    op.to.map(([, , amount]) => amount),
    op.token
  );
  world.batches.push({
    batch: {
      id: op.id,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      externalId: op.ext,
      sourceCustodyWalletId: wallet.id,
      sourceProviderWalletId: wallet.walletId,
      sourceAddress: wallet.publicKey,
      token: op.token,
      status: "confirmed",
      totalAmount,
      recipientCount: recipients.length,
      transactionCount: chunks.length,
      createdAt,
      updatedAt: iso(op.at + 2_000),
    },
    recipients,
  });
  adjustBalance(world, wallet.id, op.token, totalAmount, -1);
}

/** Where the demo provider asks an off-ramp's crypto to be sent. */
export function rampDepositAddress(rampId: string): string {
  return demoAddress(`lightspark-deposit:${rampId}`);
}

/** How each provider hands a ramp over, and the prefix of the reference it gives it. */
export const DEMO_RAMP_PROVIDERS: Record<
  RampProviderId,
  { deliveryMode: PaymentRampQuoteDeliveryMode; reference: string }
> = {
  lightspark: { deliveryMode: "manual_instructions", reference: "LS" },
  bvnk: { deliveryMode: "manual_instructions", reference: "BVNK" },
  mural: { deliveryMode: "manual_instructions", reference: "MRL" },
  moonpay: { deliveryMode: "hosted", reference: "MP" },
  coinbase: { deliveryMode: "hosted", reference: "CB" },
  moneygram: { deliveryMode: "session_widget", reference: "MG" },
  stripe: { deliveryMode: "session_widget", reference: "STR" },
};

/** The reference a provider shows for a demo quote. */
export function rampReference(provider: RampProviderId, quoteId: string): string {
  return `${DEMO_RAMP_PROVIDERS[provider].reference}-${quoteId.slice(-10).toUpperCase()}`;
}

export function consentKey(provider: RampProviderId, counterpartyId: string): string {
  return `${provider}:${counterpartyId}`;
}

function applyRamp(world: DemoWorld, op: DemoOpOf<"ramp">): void {
  const wallet = findWallet(world, op.wallet);
  const tokenKey = tokenKeyForRail(op.rail);
  if (!wallet || !tokenKey) return;
  const onramp = op.dir === "onramp";
  const depositAddress = rampDepositAddress(op.id);
  const { deliveryMode } = DEMO_RAMP_PROVIDERS[op.provider];
  world.transfers.push({
    transfer: outboundTransfer(op.id, op.at, wallet, {
      type: op.dir,
      kind: op.dir,
      direction: onramp ? "inbound" : "outbound",
      status: "awaiting_payment",
      signature: null,
      source: onramp ? demoAddress(`${op.provider}:${op.id}`) : wallet.publicKey,
      destination: onramp ? wallet.publicKey : depositAddress,
      token: DEMO_TOKENS[tokenKey].mint,
      amount: op.crypto,
      provider: op.provider,
      providerReference: rampReference(op.provider, op.quote),
      deliveryMode,
      fiatCurrency: op.fiat,
      fiatAmount: op.fiatAmount,
      ...(onramp
        ? {}
        : { cryptoDeposit: { destinationAddress: depositAddress, amount: op.crypto } }),
      ...withContact(contactById(world, op.cp)),
      updatedAt: iso(op.at),
    }),
    observed: false,
  });
}

function applyRampPaid(world: DemoWorld, op: DemoOpOf<"ramp-paid">, now: number): void {
  const transfer = transferById(world, op.id);
  if (transfer?.status !== "awaiting_payment" || !transfer.custodyWalletId) return;
  const settled = now - op.at >= DEMO_SETTLE_MS;
  transfer.status = settled ? "completed" : "settling";
  transfer.signature = demoSignature(`${op.id}:paid`);
  transfer.updatedAt = iso(settled ? op.at + DEMO_SETTLE_MS : op.at);
  if (transfer.cryptoDeposit) delete transfer.cryptoDeposit;
  const token = transfer.token ?? DEMO_TOKENS.USDC.mint;
  const amount = transfer.amount ?? "0";
  if (transfer.direction === "outbound") {
    adjustBalance(world, transfer.custodyWalletId, token, amount, -1);
  } else if (settled) {
    adjustBalance(world, transfer.custodyWalletId, token, amount, 1);
  }
}

function applyRampCancel(world: DemoWorld, op: DemoOpOf<"ramp-cancel">): void {
  const transfer = transferById(world, op.id);
  if (transfer?.status !== "awaiting_payment") return;
  transfer.status = "canceled";
  transfer.updatedAt = iso(op.at);
  if (transfer.cryptoDeposit) delete transfer.cryptoDeposit;
}

function applyPayoutAccount(world: DemoWorld, op: DemoOpOf<"payout-account">): void {
  if (!contactById(world, op.cp)) return;
  world.providerAccounts.push({
    counterpartyId: op.cp,
    account: {
      id: op.id,
      provider: "lightspark",
      kind: "payout_account",
      fiatCurrency: op.fiat,
      destinationCountry: isCountryCode(op.country) ? op.country : null,
      paymentRail: op.rail,
      status: "active",
      providerStatus: "VERIFIED",
      createdAt: iso(op.at),
      ...(op.bank ? { bankName: op.bank } : {}),
      ...(op.last4 ? { accountNumberLast4: op.last4 } : {}),
    },
  });
}

function applyRequest(world: DemoWorld, op: DemoOpOf<"request">): void {
  const wallet = findWallet(world, op.wallet);
  if (!wallet) return;
  const createdAt = iso(op.at);
  world.requests.push({
    id: op.id,
    publicToken: `demo_pt_${demoAddress(`request-token:${op.id}`).slice(0, 22)}`,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    counterpartyId: op.cp,
    walletId: wallet.walletId,
    destinationAddress: wallet.publicKey,
    token: op.token,
    amount: op.amount,
    reference: demoAddress(`request-reference:${op.id}`),
    status: "awaiting_payment",
    expiresAt: op.expires,
    fulfilledByTransferId: null,
    canceledBy: null,
    lifecycle: [{ status: "awaiting_payment", at: createdAt }],
    createdBy: CREATED_BY,
    createdAt,
    updatedAt: createdAt,
  });
}

function applySchedule(world: DemoWorld, op: DemoOpOf<"schedule">): void {
  const wallet = findWallet(world, op.wallet);
  const account = accountById(world, op.account);
  if (!wallet || !account) return;
  world.schedules.push({
    id: op.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    sourceCustodyWalletId: wallet.id,
    sourceProviderWalletId: wallet.walletId,
    sourceAddress: wallet.publicKey,
    counterpartyId: op.cp,
    counterpartyAccountId: account.id,
    destinationAddress: account.details.address,
    destinationTokenAccount: null,
    token: op.token,
    amount: op.amount,
    periodHours: op.period,
    firstCollectionAt: op.first,
    nextCollectionDueAt: op.first,
    planId: null,
    subscriptionId: null,
    planPda: null,
    planCreatedAt: null,
    planCreationSignature: null,
    subscriptionPda: null,
    subscriptionAuthorityAddress: null,
    authorizationSignature: null,
    status: "pending_activation",
    metadataUri: null,
    createdBy: CREATED_BY,
    createdAt: iso(op.at),
    updatedAt: iso(op.at),
  });
}

function activate(schedule: PaymentRecurringPayment, at: number): void {
  const seed = schedule.id;
  schedule.status = "active";
  schedule.planId = schedule.planId ?? `demo_plan_${seed}`;
  schedule.subscriptionId = schedule.subscriptionId ?? `demo_sub_${seed}`;
  schedule.planPda = schedule.planPda ?? demoAddress(`plan:${seed}`);
  schedule.planCreatedAt = schedule.planCreatedAt ?? iso(at);
  schedule.planCreationSignature = schedule.planCreationSignature ?? demoSignature(`plan:${seed}`);
  schedule.subscriptionPda = schedule.subscriptionPda ?? demoAddress(`subscription:${seed}`);
  schedule.subscriptionAuthorityAddress =
    schedule.subscriptionAuthorityAddress ?? demoAddress(`subscription-authority:${seed}`);
  schedule.authorizationSignature =
    schedule.authorizationSignature ?? demoSignature(`authorization:${seed}`);
  schedule.destinationTokenAccount =
    schedule.destinationTokenAccount ?? demoAddress(`token-account:${seed}`);
  schedule.firstCollectionAt = schedule.firstCollectionAt ?? iso(at);
  schedule.nextCollectionDueAt = schedule.firstCollectionAt;
}

/** One run collected now: a settled attempt, its transfer, and the next run a period on. */
function collect(world: DemoWorld, schedule: PaymentRecurringPayment, at: number): void {
  const wallet = findWallet(world, schedule.sourceCustodyWalletId);
  if (!wallet || !schedule.subscriptionId) return;
  const runId = `${schedule.id}_run_${at.toString(36)}`;
  const transferId = `demo_new_xfr_${at.toString(36)}_${schedule.id.slice(-6)}`;
  const dueAt = schedule.nextCollectionDueAt ?? iso(at);
  world.transfers.push({
    transfer: outboundTransfer(transferId, at, wallet, {
      kind: "recurring_pay",
      destination: schedule.destinationAddress,
      token: schedule.token,
      amount: schedule.amount,
      ...withContact(contactById(world, schedule.counterpartyId)),
    }),
    observed: false,
  });
  world.attempts.push({
    id: runId,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    subscriptionId: schedule.subscriptionId,
    transferId,
    token: schedule.token,
    amount: schedule.amount,
    dueAt,
    attemptedAt: iso(at),
    status: "confirmed",
    signature: demoSignature(transferId),
    error: null,
    metadata: { source: "manual", recurringPaymentId: schedule.id, initiatedByKeyId: null },
    createdAt: iso(at),
    updatedAt: iso(at + 2_000),
  });
  schedule.nextCollectionDueAt = iso(Date.parse(dueAt) + schedule.periodHours * HOUR_MS);
  adjustBalance(world, wallet.id, schedule.token, schedule.amount, -1);
}

function applyScheduleAction(world: DemoWorld, op: DemoOpOf<"schedule-action">): void {
  const schedule = world.schedules.find((candidate) => candidate.id === op.id);
  if (!schedule) return;
  switch (op.action) {
    case "activate":
      if (schedule.status === "pending_activation") activate(schedule, op.at);
      break;
    case "collect":
      if (schedule.status === "active") collect(world, schedule, op.at);
      break;
    case "cancel":
      if (schedule.status === "pending_activation" || schedule.status === "active") {
        schedule.status = "canceled";
        schedule.nextCollectionDueAt = null;
      }
      break;
    case "resume":
      if (schedule.status === "canceled" && schedule.subscriptionId) {
        schedule.status = "active";
        schedule.nextCollectionDueAt = iso(op.at + schedule.periodHours * HOUR_MS);
      }
      break;
  }
  schedule.updatedAt = iso(op.at);
}

function applyScheduleUpdate(world: DemoWorld, op: DemoOpOf<"schedule-update">): void {
  const schedule = world.schedules.find((candidate) => candidate.id === op.id);
  if (!schedule) return;
  if (op.amount !== undefined) schedule.amount = op.amount;
  if (op.token !== undefined) schedule.token = op.token;
  if (op.period !== undefined) schedule.periodHours = op.period;
  const wallet = op.wallet === undefined ? undefined : findWallet(world, op.wallet);
  if (wallet) {
    schedule.sourceCustodyWalletId = wallet.id;
    schedule.sourceProviderWalletId = wallet.walletId;
    schedule.sourceAddress = wallet.publicKey;
  }
  const account = op.account === undefined ? undefined : accountById(world, op.account);
  if (account) {
    schedule.counterpartyAccountId = account.id;
    schedule.destinationAddress = account.details.address;
  }
  schedule.updatedAt = iso(op.at);
}

function applyOp(world: DemoWorld, op: DemoOp, now: number): void {
  switch (op.k) {
    case "contact":
      applyContact(world, op);
      return;
    case "contact-archive":
      applyContactArchive(world, op);
      return;
    case "address":
      applyAddress(world, op);
      return;
    case "send":
      applySend(world, op);
      return;
    case "batch":
      applyBatch(world, op);
      return;
    case "ramp":
      applyRamp(world, op);
      return;
    case "ramp-paid":
      applyRampPaid(world, op, now);
      return;
    case "ramp-cancel":
      applyRampCancel(world, op);
      return;
    case "consent":
      if (contactById(world, op.id)) world.consents.push(consentKey(op.provider, op.id));
      return;
    case "verified":
      if (contactById(world, op.id)) world.verifications[consentKey(op.provider, op.id)] = op.at;
      return;
    case "payout-account":
      applyPayoutAccount(world, op);
      return;
    case "request":
      applyRequest(world, op);
      return;
    case "schedule":
      applySchedule(world, op);
      return;
    case "schedule-action":
      applyScheduleAction(world, op);
      return;
    case "schedule-update":
      applyScheduleUpdate(world, op);
      return;
  }
}

/** The world with the session's actions applied, every list back in newest-first order. */
export function applyDemoOps(world: DemoWorld, ops: readonly DemoOp[], now: Date): DemoWorld {
  if (ops.length === 0) return world;
  for (const op of ops) applyOp(world, op, now.getTime());
  world.transfers.sort((left, right) =>
    right.transfer.createdAt.localeCompare(left.transfer.createdAt)
  );
  world.batches.sort((left, right) => right.batch.createdAt.localeCompare(left.batch.createdAt));
  newestFirst(world.requests);
  newestFirst(world.schedules);
  return world;
}
