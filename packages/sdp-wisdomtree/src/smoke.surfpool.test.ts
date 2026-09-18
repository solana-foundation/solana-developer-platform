import { getWisdomTreeOnReceiptWallet } from "@sdp/earn/providers/wisdomtree/connect";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { AccountState, findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { createWisdomTreeChainReader, tokenAccountBaseUnits } from "./chain";
import { buildWisdomTreeDepositPlan, buildWisdomTreeRedemptionPlan } from "./plan";

/**
 * Opt-in proof against a Surfpool fork of MAINNET. The host-side entrypoint is
 * Docker-only and requires three secrets/prerequisites. Preload
 * WISDOMTREE_SURFPOOL_MAINNET_RPC_URL,
 * WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY, and WISDOMTREE_API_KEY from a secure
 * environment or secret manager, then run only:
 *
 *   scripts/kora-surfpool/e2e-wisdomtree.sh
 *
 * The signer must be a real, user-controlled mainnet wallet holding SOL, USDC,
 * WTGXX, and a live WisdomTree credential. The test resolves WisdomTree's real
 * Purchase and Sale on-receipt wallets through Connect, builds against the live
 * mainnet accounts Surfpool clones, signs every simulation cryptographically,
 * keeps signature verification enabled, and asserts exact token deltas.
 *
 * The ONLY Surfpool state write is the explicitly allowed KYC shortcut: clone
 * the signer's real registrar credential account shape into the exact ATA of a
 * fresh compliance-probe recipient. All cheatcodes are permanently locked
 * immediately afterwards. There is no SOL/token funding, signer impersonation,
 * fake share/proceeds settlement, or broadcast to mainnet.
 */
const SURFPOOL_RPC_URL = process.env.WISDOMTREE_SMOKE_RPC_URL ?? "";
const MAINNET_RPC_URL = process.env.SURFPOOL_REMOTE_RPC_URL ?? "";
const SIGNER_PRIVATE_KEY = process.env.WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY ?? "";
const CONNECT_CREDENTIAL = process.env.WISDOMTREE_API_KEY ?? "";
const RUN_SURFPOOL_E2E = process.env.WISDOMTREE_SURFPOOL_E2E === "true";

const WTGXX =
  WISDOMTREE_FUNDS.find((fund) => fund.exchangeCode === "WTGXX") ??
  (() => {
    throw new Error("the shared WisdomTree registry has no WTGXX fund");
  })();
const WTGXX_MINT = address(WTGXX.mint);
const MAINNET_USDC = wellKnownMint("USDC", "mainnet-beta");
if (!MAINNET_USDC) throw new Error("the shared token registry has no mainnet USDC mint");
const USDC_MINT = address(MAINNET_USDC);
const HOOK_PROGRAM = address(WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] ?? "");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const TOKEN_2022_PROGRAM = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const ONE_USDC_ATOM = "0.000001";
const ONE_WTGXX_ATOM = "0.000000001";
const MIN_SIGNER_LAMPORTS = 5_000_000;

type MainnetSigner = Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;

interface EncodedAccount {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
}

interface SimulationValue {
  accounts?: (EncodedAccount | null)[] | null;
  err: unknown;
  logs?: string[] | null;
}

interface SignerAssets {
  usdcAccount: Address;
  usdcBalance: bigint;
  wtgxxAccount: Address;
  wtgxxBalance: bigint;
}

interface ComplianceProbe {
  credentialMint: Address;
  credentialTemplate: Uint8Array;
  destinationCredential: Address;
  destinationFundAccount: Address;
  plan: Awaited<ReturnType<typeof buildWisdomTreeRedemptionPlan>>;
}

let rpcRequestId = 0;

async function rpcCall<T>(endpoint: string, method: string, params: readonly unknown[] = []) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcRequestId, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    if ([429, 502, 503, 504].includes(response.status) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
    const body = (await response.json()) as {
      error?: { code?: number; message?: string; data?: unknown };
      result?: T;
    };
    if (body.error) {
      const throttled =
        body.error.code === 429 ||
        body.error.code === -32005 ||
        body.error.message?.toLowerCase().includes("too many requests");
      if (throttled && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
        continue;
      }
      throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    if (!("result" in body)) throw new Error(`${method} returned no result`);
    return body.result as T;
  }
  throw new Error(`${method} exhausted its RPC retries`);
}

function decodeAccountData(account: EncodedAccount): Uint8Array {
  const [encoded, encoding] = account.data;
  if (encoding !== "base64") {
    throw new Error(`RPC returned unsupported account encoding ${encoding}`);
  }
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}

async function getAccounts(endpoint: string, accountAddresses: readonly Address[]) {
  const result = await rpcCall<{ value: (EncodedAccount | null)[] }>(
    endpoint,
    "getMultipleAccounts",
    [accountAddresses.map(String), { commitment: "confirmed", encoding: "base64" }]
  );
  return result.value;
}

function decodeSignerSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();
  let decoded: Uint8Array;
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY must be a Solana CLI JSON array or base58 secret"
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255
      )
    ) {
      throw new Error("WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY JSON must contain only byte values");
    }
    decoded = Uint8Array.from(parsed);
  } else {
    try {
      decoded = new Uint8Array(getBase58Encoder().encode(trimmed));
    } catch {
      throw new Error(
        "WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY must be a Solana CLI JSON array or base58 secret"
      );
    }
  }
  if (decoded.length !== 64) {
    throw new Error(
      `WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY must decode to 64 bytes; received ${decoded.length}`
    );
  }
  return decoded;
}

async function requireMainnetSignerAssets(signer: MainnetSigner): Promise<SignerAssets> {
  const [usdcAccount] = await findAssociatedTokenPda({
    owner: signer.address,
    mint: USDC_MINT,
    tokenProgram: TOKEN_PROGRAM,
  });
  const [wtgxxAccount] = await findAssociatedTokenPda({
    owner: signer.address,
    mint: WTGXX_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  const [owner, usdc, wtgxx] = await getAccounts(MAINNET_RPC_URL, [
    signer.address,
    usdcAccount,
    wtgxxAccount,
  ]);
  if (!owner || owner.owner !== SYSTEM_PROGRAM || owner.lamports < MIN_SIGNER_LAMPORTS) {
    throw new Error(
      `The supplied signer must control a mainnet system account with at least ${MIN_SIGNER_LAMPORTS} lamports`
    );
  }
  if (!usdc || usdc.owner !== String(TOKEN_PROGRAM)) {
    throw new Error("The supplied signer has no canonical mainnet USDC token account");
  }
  if (!wtgxx || wtgxx.owner !== String(TOKEN_2022_PROGRAM)) {
    throw new Error("The supplied signer has no canonical mainnet WTGXX token account");
  }
  const usdcBalance = tokenAccountBaseUnits(decodeAccountData(usdc));
  const wtgxxBalance = tokenAccountBaseUnits(decodeAccountData(wtgxx));
  if (usdcBalance < 1n) {
    throw new Error("The supplied signer must hold at least one real mainnet USDC atom");
  }
  if (wtgxxBalance < 1n) {
    throw new Error("The supplied signer must hold at least one real mainnet WTGXX atom");
  }
  return { usdcAccount, usdcBalance, wtgxxAccount, wtgxxBalance };
}

async function tokenBalanceOrZero(
  endpoint: string,
  tokenAccount: Address,
  expectedProgram: Address
): Promise<bigint> {
  const [account] = await getAccounts(endpoint, [tokenAccount]);
  if (!account) return 0n;
  if (account.owner !== String(expectedProgram)) {
    throw new Error(`${tokenAccount} is owned by ${account.owner}, not ${expectedProgram}`);
  }
  return tokenAccountBaseUnits(decodeAccountData(account));
}

async function simulateSigned(
  signer: MainnetSigner,
  instructions: readonly Instruction[],
  returnedAccounts: readonly Address[]
): Promise<SimulationValue> {
  const rpc = createSolanaRpc(SURFPOOL_RPC_URL);
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([...instructions], m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  return (
    await rpcCall<{ value: SimulationValue }>(SURFPOOL_RPC_URL, "simulateTransaction", [
      wire,
      {
        accounts: { addresses: returnedAccounts.map(String), encoding: "base64" },
        commitment: "confirmed",
        encoding: "base64",
        sigVerify: true,
      },
    ])
  ).value;
}

function simulatedTokenBalanceOrZero(value: SimulationValue, index: number): bigint {
  const account = value.accounts?.[index];
  return account ? tokenAccountBaseUnits(decodeAccountData(account)) : 0n;
}

function assertSuccessfulTransfer(
  value: SimulationValue,
  sourceBefore: bigint,
  destinationBefore: bigint,
  label: string
) {
  expect(value.err, `${label} failed: ${JSON.stringify(value.logs)}`).toBeNull();
  expect(simulatedTokenBalanceOrZero(value, 0)).toBe(sourceBefore - 1n);
  expect(simulatedTokenBalanceOrZero(value, 1)).toBe(destinationBefore + 1n);
}

function assertCredentialTemplate(
  data: Uint8Array,
  credentialMint: Address,
  credentialOwner: Address
) {
  if (data.length < 165) throw new Error("the real WisdomTree credential account is truncated");
  const decodedMint = getAddressDecoder().decode(data.subarray(0, 32));
  const decodedOwner = getAddressDecoder().decode(data.subarray(32, 64));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (String(decodedMint) !== String(credentialMint)) {
    throw new Error("the real WisdomTree credential account names the wrong mint");
  }
  if (String(decodedOwner) !== String(credentialOwner)) {
    throw new Error("the real WisdomTree credential account names the wrong owner");
  }
  if (
    view.getBigUint64(64, true) !== 1n ||
    view.getUint32(72, true) !== 0 ||
    data[108] !== AccountState.Initialized ||
    view.getUint32(109, true) !== 0 ||
    view.getBigUint64(121, true) !== 0n ||
    view.getUint32(129, true) !== 0
  ) {
    throw new Error("the real WisdomTree credential is not an immutable one-token account");
  }
}

async function buildComplianceProbe(
  signer: MainnetSigner,
  signerAssets: SignerAssets,
  destinationOwner: Address
): Promise<ComplianceProbe> {
  const reader = createWisdomTreeChainReader(SURFPOOL_RPC_URL);
  const plan = await buildWisdomTreeRedemptionPlan(
    reader,
    { cluster: "mainnet-beta", rpcUrl: SURFPOOL_RPC_URL },
    {
      fund: WTGXX,
      owner: signer,
      onReceiptWallet: destinationOwner,
      depositMint: USDC_MINT,
      shares: ONE_WTGXX_ATOM,
    }
  );
  const transferAccounts = plan.instructions.at(-1)?.accounts ?? [];
  if (transferAccounts.length !== 11) {
    throw new Error(
      `WTGXX hook account layout drifted: expected 11, got ${transferAccounts.length}`
    );
  }
  const [destinationFundAccount] = await findAssociatedTokenPda({
    owner: destinationOwner,
    mint: WTGXX_MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  if (
    String(transferAccounts[0]?.address) !== String(signerAssets.wtgxxAccount) ||
    String(transferAccounts[2]?.address) !== String(destinationFundAccount)
  ) {
    throw new Error("the compliance probe does not transfer between the expected WTGXX ATAs");
  }

  const complianceConfigAddress = transferAccounts[4]?.address;
  if (!complianceConfigAddress) throw new Error("WTGXX hook omitted its compliance config");
  const complianceConfig = await reader.getAccount(complianceConfigAddress);
  if (!complianceConfig || complianceConfig.data.length < 72) {
    throw new Error("WTGXX compliance config omitted its credential mint");
  }
  const credentialMint = getAddressDecoder().decode(complianceConfig.data.subarray(40, 72));
  const [sourceCredential] = await findAssociatedTokenPda({
    owner: signer.address,
    mint: credentialMint,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  const [destinationCredential] = await findAssociatedTokenPda({
    owner: destinationOwner,
    mint: credentialMint,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  if (
    String(transferAccounts[7]?.address) !== String(sourceCredential) ||
    String(transferAccounts[8]?.address) !== String(destinationCredential)
  ) {
    throw new Error("WTGXX no longer resolves the expected source/destination credential ATAs");
  }

  const [credentialMintAccount, sourceCredentialAccount, destinationCredentialAccount] =
    await getAccounts(MAINNET_RPC_URL, [credentialMint, sourceCredential, destinationCredential]);
  if (credentialMintAccount?.owner !== String(TOKEN_2022_PROGRAM)) {
    throw new Error("WTGXX compliance config points at a non-Token-2022 credential mint");
  }
  if (sourceCredentialAccount?.owner !== String(TOKEN_2022_PROGRAM)) {
    throw new Error("The supplied signer has WTGXX but no live mainnet WisdomTree credential");
  }
  if (destinationCredentialAccount !== null) {
    throw new Error("the fresh compliance-probe recipient unexpectedly has a mainnet credential");
  }
  const credentialTemplate = decodeAccountData(sourceCredentialAccount);
  assertCredentialTemplate(credentialTemplate, credentialMint, signer.address);

  const [forkSourceCredential, forkDestinationCredential, [mainnetDestinationFund]] =
    await Promise.all([
      reader.getAccount(sourceCredential),
      reader.getAccount(destinationCredential),
      getAccounts(MAINNET_RPC_URL, [destinationFundAccount]),
    ]);
  if (
    forkSourceCredential?.owner !== String(TOKEN_2022_PROGRAM) ||
    !Buffer.from(forkSourceCredential.data).equals(Buffer.from(credentialTemplate))
  ) {
    throw new Error("Surfpool did not clone the signer's real mainnet credential exactly");
  }
  if (forkDestinationCredential !== null || mainnetDestinationFund !== null) {
    throw new Error("the fresh compliance-probe recipient is not empty on mainnet/fork");
  }

  return {
    credentialMint,
    credentialTemplate,
    destinationCredential,
    destinationFundAccount,
    plan,
  };
}

function hex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The only state-writing helper: install one exact, derived KYC credential ATA. */
async function installDestinationKycCredential(probe: ComplianceProbe, destinationOwner: Address) {
  const [expectedCredential] = await findAssociatedTokenPda({
    owner: destinationOwner,
    mint: probe.credentialMint,
    tokenProgram: TOKEN_2022_PROGRAM,
  });
  if (String(probe.destinationCredential) !== String(expectedCredential)) {
    throw new Error("the KYC shortcut may write only the destination's derived credential ATA");
  }
  const [existing] = await getAccounts(SURFPOOL_RPC_URL, [probe.destinationCredential]);
  if (existing !== null) {
    throw new Error("refusing to overwrite an existing destination credential account");
  }

  const data = new Uint8Array(probe.credentialTemplate);
  data.set(getAddressEncoder().encode(destinationOwner), 32);
  assertCredentialTemplate(data, probe.credentialMint, destinationOwner);
  const lamports = await rpcCall<number>(SURFPOOL_RPC_URL, "getMinimumBalanceForRentExemption", [
    data.length,
    { commitment: "confirmed" },
  ]);
  await rpcCall(SURFPOOL_RPC_URL, "surfnet_setAccount", [
    String(probe.destinationCredential),
    {
      lamports,
      owner: String(TOKEN_2022_PROGRAM),
      data: hex(data),
      executable: false,
      rentEpoch: 0,
    },
  ]);

  const [installed] = await getAccounts(SURFPOOL_RPC_URL, [probe.destinationCredential]);
  if (
    installed?.owner !== String(TOKEN_2022_PROGRAM) ||
    !Buffer.from(decodeAccountData(installed)).equals(Buffer.from(data))
  ) {
    throw new Error("Surfpool did not install the exact derived KYC credential ATA");
  }
}

async function permanentlyLockAllCheatcodes() {
  await rpcCall(SURFPOOL_RPC_URL, "surfnet_disableCheatcode", ["all", { lockout: true }]);
}

describe.skipIf(!RUN_SURFPOOL_E2E)(
  "WisdomTree signed flows against a Surfpool mainnet fork",
  () => {
    it("uses real on-receipt wallets and permits only the KYC credential shortcut", async () => {
      if (!SURFPOOL_RPC_URL || !MAINNET_RPC_URL) {
        throw new Error("the container runner must provide Surfpool and mainnet RPC URLs");
      }
      if (!SIGNER_PRIVATE_KEY) {
        throw new Error("WISDOMTREE_SURFPOOL_SIGNER_PRIVATE_KEY is required");
      }
      if (!CONNECT_CREDENTIAL) {
        throw new Error("WISDOMTREE_API_KEY packed production credentials are required");
      }
      expect(await rpcCall<string>(MAINNET_RPC_URL, "getGenesisHash")).toBe(MAINNET_GENESIS_HASH);
      expect(await rpcCall<string>(SURFPOOL_RPC_URL, "getGenesisHash")).toBe(MAINNET_GENESIS_HASH);

      const signer = await createKeyPairSignerFromBytes(decodeSignerSecret(SIGNER_PRIVATE_KEY));
      const signerAssets = await requireMainnetSignerAssets(signer);
      expect(
        await tokenBalanceOrZero(SURFPOOL_RPC_URL, signerAssets.usdcAccount, TOKEN_PROGRAM)
      ).toBe(signerAssets.usdcBalance);
      expect(
        await tokenBalanceOrZero(SURFPOOL_RPC_URL, signerAssets.wtgxxAccount, TOKEN_2022_PROGRAM)
      ).toBe(signerAssets.wtgxxBalance);

      const ctx: EarnRuntimeContext = {
        environment: "production",
        env: { WISDOMTREE_API_KEY: CONNECT_CREDENTIAL },
      };
      const purchaseWalletText = await getWisdomTreeOnReceiptWallet(ctx, {
        tradeType: "Purchase",
        fund: WTGXX.exchangeCode,
        currency: "USDC",
      });
      // Resolve sequentially so the Connect client's bearer-token cache reuses
      // the exact authenticated production context instead of racing two grants.
      const saleWalletText = await getWisdomTreeOnReceiptWallet(ctx, {
        tradeType: "Sale",
        fund: WTGXX.exchangeCode,
        currency: "USDC",
      });
      const purchaseWallet = address(purchaseWalletText);
      const saleWallet = address(saleWalletText);
      if (
        String(purchaseWallet) === String(signer.address) ||
        String(saleWallet) === String(signer.address)
      ) {
        throw new Error("WisdomTree Connect returned the signer itself as an on-receipt wallet");
      }

      const reader = createWisdomTreeChainReader(SURFPOOL_RPC_URL);
      const freshRecipient = await generateKeyPairSigner();
      const complianceProbe = await buildComplianceProbe(
        signer,
        signerAssets,
        freshRecipient.address
      );
      const [purchaseUsdcAccount] = await findAssociatedTokenPda({
        owner: purchaseWallet,
        mint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM,
      });
      const [saleWtgxxAccount] = await findAssociatedTokenPda({
        owner: saleWallet,
        mint: WTGXX_MINT,
        tokenProgram: TOKEN_2022_PROGRAM,
      });

      // Build every real flow and lazy-clone every measured account before
      // cheatcodes are locked. Only the user-controlled signer ever signs.
      const [deposit, redemption] = await Promise.all([
        buildWisdomTreeDepositPlan(
          reader,
          { cluster: "mainnet-beta", rpcUrl: SURFPOOL_RPC_URL },
          {
            fund: WTGXX,
            owner: signer,
            onReceiptWallet: purchaseWallet,
            depositMint: USDC_MINT,
            depositDecimals: 6,
            amount: ONE_USDC_ATOM,
          }
        ),
        buildWisdomTreeRedemptionPlan(
          reader,
          { cluster: "mainnet-beta", rpcUrl: SURFPOOL_RPC_URL },
          {
            fund: WTGXX,
            owner: signer,
            onReceiptWallet: saleWallet,
            depositMint: USDC_MINT,
            shares: ONE_WTGXX_ATOM,
          }
        ),
      ]);
      expect(deposit.accepted).toEqual({ amount: ONE_USDC_ATOM });
      expect(redemption.accepted).toEqual({ shares: ONE_WTGXX_ATOM });
      expect(complianceProbe.plan.accepted).toEqual({ shares: ONE_WTGXX_ATOM });

      const [purchaseUsdcBefore, saleWtgxxBefore] = await Promise.all([
        tokenBalanceOrZero(MAINNET_RPC_URL, purchaseUsdcAccount, TOKEN_PROGRAM),
        tokenBalanceOrZero(MAINNET_RPC_URL, saleWtgxxAccount, TOKEN_2022_PROGRAM),
      ]);
      expect(await tokenBalanceOrZero(SURFPOOL_RPC_URL, purchaseUsdcAccount, TOKEN_PROGRAM)).toBe(
        purchaseUsdcBefore
      );
      expect(await tokenBalanceOrZero(SURFPOOL_RPC_URL, saleWtgxxAccount, TOKEN_2022_PROGRAM)).toBe(
        saleWtgxxBefore
      );

      const rejected = await simulateSigned(signer, complianceProbe.plan.instructions, [
        signerAssets.wtgxxAccount,
        complianceProbe.destinationFundAccount,
      ]);
      expect(
        rejected.err,
        "a recipient without WisdomTree's credential must not receive WTGXX"
      ).not.toBeNull();
      const rejectionLogs = (rejected.logs ?? []).join("\n");
      expect(rejectionLogs).toContain(`Program ${HOOK_PROGRAM} invoke`);
      expect(rejectionLogs).toContain("EmptySbtAccount");
      expect(simulatedTokenBalanceOrZero(rejected, 0)).toBe(signerAssets.wtgxxBalance);
      expect(simulatedTokenBalanceOrZero(rejected, 1)).toBe(0n);

      // The sole shortcut stands in for WisdomTree's unfinished KYB/KYC
      // issuance step. Lock every cheatcode permanently before positive flows.
      await installDestinationKycCredential(complianceProbe, freshRecipient.address);
      await permanentlyLockAllCheatcodes();

      const credentialed = await simulateSigned(signer, complianceProbe.plan.instructions, [
        signerAssets.wtgxxAccount,
        complianceProbe.destinationFundAccount,
      ]);
      assertSuccessfulTransfer(
        credentialed,
        signerAssets.wtgxxBalance,
        0n,
        "credentialed WTGXX hook probe"
      );
      const credentialedLogs = (credentialed.logs ?? []).join("\n");
      expect(credentialedLogs).toContain(`Program ${HOOK_PROGRAM} invoke`);
      expect(credentialedLogs).toContain(`Program ${HOOK_PROGRAM} success`);

      const depositSimulation = await simulateSigned(signer, deposit.instructions, [
        signerAssets.usdcAccount,
        purchaseUsdcAccount,
      ]);
      assertSuccessfulTransfer(
        depositSimulation,
        signerAssets.usdcBalance,
        purchaseUsdcBefore,
        "real Purchase on-receipt transfer"
      );

      const redemptionSimulation = await simulateSigned(signer, redemption.instructions, [
        signerAssets.wtgxxAccount,
        saleWtgxxAccount,
      ]);
      assertSuccessfulTransfer(
        redemptionSimulation,
        signerAssets.wtgxxBalance,
        saleWtgxxBefore,
        "real Sale on-receipt transfer"
      );
      const redemptionLogs = (redemptionSimulation.logs ?? []).join("\n");
      expect(redemptionLogs).toContain(`Program ${HOOK_PROGRAM} invoke`);
      expect(redemptionLogs).toContain(`Program ${HOOK_PROGRAM} success`);
    });
  }
);
