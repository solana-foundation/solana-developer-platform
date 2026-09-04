import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { GENESIS_HASH_BY_CLUSTER, wellKnownMint } from "@sdp/types";
import {
  isVedaDeployed,
  VEDA_DEPLOYMENTS,
  VEDA_DEPOSIT_TOKEN_SYMBOLS,
  type VedaDeployment,
  vedaDeployment,
  vedaDepositMints,
} from "@sdp/types/veda-programs";
import { toBase58 } from "../../solana-rpc";
import { isStrategyWithinDeclaredSupport } from "../../support";
import type { ProviderStrategySnapshot } from "../../types";
import { VedaEarnClient } from "./client";
import {
  decodeAssetData,
  decodeBoringVault,
  VEDA_ASSET_DATA_DISCRIMINATOR,
  VEDA_ASSET_DATA_LAYOUT,
  VEDA_BORING_VAULT_DISCRIMINATOR,
  VEDA_BORING_VAULT_LAYOUT,
  VEDA_BORING_VAULT_SIZE,
  VEDA_UNSET_AUTHORITY,
} from "./vault-state";

/**
 * Canonical no-network harness (see src/fetch.test.ts): `globalThis.fetch` is
 * stubbed per test and restored in `afterEach`. Nothing here reaches an RPC.
 *
 * Note what is absent and is the point of this provider: no API key in any
 * context. Veda is read entirely on chain, so the only thing that can be
 * misconfigured is the DEPLOYMENT — which is what `PROVIDER_NOT_CONFIGURED`
 * reports here.
 */

const client = new VedaEarnClient();

const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const USDT_MAINNET = wellKnownMint("USDT", "mainnet-beta") as string;
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fixture addresses are ENCODED from bytes rather than written by hand: a
 * hand-typed base58 string is easy to make invalid (no `0`, `O`, `I` or `l`)
 * and easy to make longer than 32 bytes, and either mistake fails inside the
 * fixture builder rather than in the code under test.
 */
function fixtureAddress(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = ((seed * 31 + i * 7) % 251) + 1;
  return toBase58(bytes);
}

const VAULT_ADDRESS = fixtureAddress(1);
const SHARE_MINT = fixtureAddress(2);
const NAMED_AUTHORITY = fixtureAddress(3);
/** A mint the well-known token catalogue does not know. */
const UNKNOWN_MINT = fixtureAddress(4);

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: fixtureAddress(5),
  queueProgramAddress: fixtureAddress(6),
  hookProgramAddress: fixtureAddress(7),
  vaultStateAddresses: [VAULT_ADDRESS],
};

// --- fixture encoders, written through the exported layout ------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 → 32 bytes, so a fixture can state addresses the way the chain does. */
function decodeBase58(value: string): Uint8Array {
  let n = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    assert.ok(index >= 0, `invalid base58 character ${char}`);
    n = n * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  while (bytes.length < 32) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

function writeUintLe(data: Uint8Array, offset: number, value: bigint, length: number): void {
  let remaining = value < 0n ? (1n << BigInt(length * 8)) + value : value;
  for (let i = 0; i < length; i += 1) {
    data[offset + i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

interface VaultFixture {
  vaultId?: bigint;
  shareMint?: string;
  baseAsset?: string;
  shareDecimals?: number;
  withdrawAuthority?: string;
  lockDurationSeconds?: bigint;
  platformFeeBps?: number;
  performanceFeeBps?: number;
}

function encodeBoringVault(fixture: VaultFixture = {}): Uint8Array {
  const { offsets } = VEDA_BORING_VAULT_LAYOUT;
  const data = new Uint8Array(VEDA_BORING_VAULT_SIZE);
  data.set(VEDA_BORING_VAULT_DISCRIMINATOR, 0);
  writeUintLe(data, offsets["config.vaultId"], fixture.vaultId ?? 7n, 8);
  data.set(decodeBase58(fixture.shareMint ?? SHARE_MINT), offsets["config.shareMint"]);
  data.set(decodeBase58(fixture.baseAsset ?? USDC_DEVNET), offsets["teller.baseAsset"]);
  data[offsets["teller.decimals"]] = fixture.shareDecimals ?? 6;
  data.set(
    decodeBase58(fixture.withdrawAuthority ?? VEDA_UNSET_AUTHORITY),
    offsets["teller.withdrawAuthority"]
  );
  writeUintLe(data, offsets["config.lockDurationSeconds"], fixture.lockDurationSeconds ?? 0n, 8);
  writeUintLe(data, offsets["teller.platformFeeBps"], BigInt(fixture.platformFeeBps ?? 25), 2);
  writeUintLe(
    data,
    offsets["teller.performanceFeeBps"],
    BigInt(fixture.performanceFeeBps ?? 1000),
    2
  );
  return data;
}

function encodeAssetData(
  mint: string,
  options: { vaultId?: bigint; allowDeposits?: boolean; allowWithdrawals?: boolean } = {}
): Uint8Array {
  const { offsets, size } = VEDA_ASSET_DATA_LAYOUT;
  // Longer than the read prefix, matching the real account's variable tail.
  const data = new Uint8Array(size + 64);
  data.set(VEDA_ASSET_DATA_DISCRIMINATOR, 0);
  writeUintLe(data, offsets.vaultId, options.vaultId ?? 7n, 8);
  data.set(decodeBase58(mint), offsets.assetMint);
  data[offsets.allowDeposits] = options.allowDeposits === false ? 0 : 1;
  data[offsets.allowWithdrawals] = options.allowWithdrawals === false ? 0 : 1;
  return data;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// --- RPC stub ---------------------------------------------------------------

interface RpcStub {
  genesis?: string;
  /** `null` marks a configured vault whose account does not exist. */
  accounts?: (Uint8Array | null)[];
  assets?: { pubkey: string; data: Uint8Array }[];
  /** Return asset entries with no `account.data`, as a malformed node might. */
  stripAssetData?: boolean;
  /** Force a JSON-RPC error body on this method. */
  errorOn?: string;
}

function stubRpc(stub: RpcStub) {
  const calls: { method: string; params: unknown[] }[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });

    if (stub.errorOn === body.method) {
      return new Response(JSON.stringify({ error: { message: "node behind" } }), { status: 200 });
    }

    const result = (() => {
      if (body.method === "getGenesisHash") {
        return stub.genesis ?? GENESIS_HASH_BY_CLUSTER.devnet;
      }
      if (body.method === "getMultipleAccounts") {
        return {
          value: (stub.accounts ?? []).map((data) =>
            data === null ? null : { data: [toBase64(data), "base64"] }
          ),
        };
      }
      if (body.method === "getProgramAccounts") {
        return (stub.assets ?? []).map((asset) => ({
          pubkey: asset.pubkey,
          account: stub.stripAssetData ? {} : { data: [toBase64(asset.data), "base64"] },
        }));
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    })();

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  });
  return calls;
}

const RPC_URL = "https://rpc.test.invalid";

afterEach(() => {
  mock.restoreAll();
});

function snapshot(overrides: Partial<ProviderStrategySnapshot>): ProviderStrategySnapshot {
  return {
    providerReference: VAULT_ADDRESS,
    name: "Veda USDC vault #7",
    sourceKind: "defi",
    depositMints: [USDC_DEVNET],
    apyType: "variable",
    liquidityTerm: "instant",
    hostCluster: "devnet",
    ...overrides,
  };
}

describe("VedaEarnClient.declaredSupport", () => {
  it("declares USDC only, sourced from the shared registry", () => {
    assert.deepEqual(client.declaredSupport.depositTokens, ["USDC"]);
    assert.deepEqual([...VEDA_DEPOSIT_TOKEN_SYMBOLS], [...client.declaredSupport.depositTokens]);
  });

  /**
   * `rwa` is the filter an integrator uses to find instruments with real-world
   * backing, so claiming it is SDP vouching rather than quoting. Nothing Veda
   * publishes on-chain establishes it, so the envelope must not carry it — this
   * is the same rule that keeps every Kamino snapshot `defi`.
   */
  it("does not claim the rwa source kind", () => {
    assert.deepEqual(client.declaredSupport.sourceKinds, ["defi"]);
    assert.equal(
      isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ sourceKind: "rwa" })),
      false
    );
  });

  it("admits a USDC vault on either cluster", () => {
    for (const mint of [USDC_DEVNET, USDC_MAINNET]) {
      assert.equal(
        isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ depositMints: [mint] })),
        true
      );
    }
  });

  it("refuses assets outside the envelope, including a second stablecoin", () => {
    for (const mint of [USDT_MAINNET, SOL_MINT]) {
      assert.equal(
        isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot({ depositMints: [mint] })),
        false
      );
    }
  });
});

describe("the Veda deployment registry", () => {
  /**
   * The load-bearing state of this stack, asserted rather than assumed.
   * DEVNET is confirmed (Veda's integration docs + SDP's on-chain audit, see
   * the header in @sdp/types/veda-programs) — these are the exact addresses
   * from that confirmation, restated here so a typo in the table cannot pass.
   * MAINNET deliberately stays undeployed: the published mainnet vault state
   * is Veda's shared Test Vault, and cataloguing it would put a test vault on
   * the production shelf. When Veda names a production vault, this test is the
   * one that changes — with the confirmation in the pull request that does.
   */
  it("reports the confirmed devnet Test Vault deployment and no mainnet one", () => {
    assert.deepEqual(vedaDeployment("devnet"), {
      vaultProgramAddress: "ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J",
      queueProgramAddress: "fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT",
      hookProgramAddress: "BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2",
      vaultStateAddresses: ["3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU"],
    });
    assert.equal(isVedaDeployed("devnet"), true);
    assert.equal(vedaDeployment("mainnet-beta"), null);
    assert.equal(isVedaDeployed("mainnet-beta"), false);
  });

  it("states both clusters explicitly, so a missing one is a visible gap", () => {
    assert.deepEqual(Object.keys(VEDA_DEPLOYMENTS).sort(), ["devnet", "mainnet-beta"]);
  });

  it("resolves declared deposit symbols to each cluster's own mint", () => {
    assert.deepEqual(vedaDepositMints("devnet"), [USDC_DEVNET]);
    assert.deepEqual(vedaDepositMints("mainnet-beta"), [USDC_MAINNET]);
    assert.notEqual(USDC_DEVNET, USDC_MAINNET);
  });
});

describe("decodeBoringVault", () => {
  it("reads the fields the catalogue needs", () => {
    const decoded = decodeBoringVault(VAULT_ADDRESS, encodeBoringVault());
    assert.deepEqual(decoded, {
      address: VAULT_ADDRESS,
      vaultId: 7n,
      shareMint: SHARE_MINT,
      baseAsset: USDC_DEVNET,
      shareDecimals: 6,
      accountingPaused: false,
      tellerPaused: false,
      withdrawAuthority: VEDA_UNSET_AUTHORITY,
      lockDurationSeconds: 0n,
      platformFeeBps: 25,
      performanceFeeBps: 1000,
      complianceMode: false,
    });
  });

  /**
   * The layout is derived from Veda's published IDL field order, and 512 bytes
   * is what that order sums to. Pinned as a number so a mistake in the table —
   * a missing field, a wrong width — fails here rather than by shifting every
   * offset after it and reading a plausible wrong mint.
   */
  it("expects a 512-byte account", () => {
    assert.equal(VEDA_BORING_VAULT_SIZE, 512);
    assert.equal(decodeBoringVault(VAULT_ADDRESS, new Uint8Array(511)), null);
    assert.equal(decodeBoringVault(VAULT_ADDRESS, new Uint8Array(513)), null);
  });

  it("refuses an account that is not a BoringVault", () => {
    const wrongDiscriminator = encodeBoringVault();
    wrongDiscriminator[0] = 0;
    assert.equal(decodeBoringVault(VAULT_ADDRESS, wrongDiscriminator), null);
  });

  /**
   * An all-zero pubkey is the system program, never a mint — the signature of
   * reading the wrong offset, and the one corruption a size check cannot see.
   */
  it("refuses a vault whose share or base mint decodes to the unset pubkey", () => {
    const noShare = encodeBoringVault({ shareMint: VEDA_UNSET_AUTHORITY });
    assert.equal(decodeBoringVault(VAULT_ADDRESS, noShare), null);
    const noBase = encodeBoringVault({ baseAsset: VEDA_UNSET_AUTHORITY });
    assert.equal(decodeBoringVault(VAULT_ADDRESS, noBase), null);
  });

  it("refuses an impossible share decimal count", () => {
    assert.equal(decodeBoringVault(VAULT_ADDRESS, encodeBoringVault({ shareDecimals: 40 })), null);
  });
});

describe("decodeAssetData", () => {
  it("reads the mint and both permission flags", () => {
    assert.deepEqual(decodeAssetData(encodeAssetData(USDC_DEVNET)), {
      vaultId: 7n,
      assetMint: USDC_DEVNET,
      allowDeposits: true,
      allowWithdrawals: true,
    });
    assert.deepEqual(decodeAssetData(encodeAssetData(USDC_DEVNET, { allowDeposits: false })), {
      vaultId: 7n,
      assetMint: USDC_DEVNET,
      allowDeposits: false,
      allowWithdrawals: true,
    });
  });

  it("refuses a truncated or foreign account", () => {
    assert.equal(decodeAssetData(new Uint8Array(8)), null);
    const foreign = encodeAssetData(USDC_DEVNET);
    foreign[0] = 0;
    assert.equal(decodeAssetData(foreign), null);
  });
});

describe("VedaEarnClient.listStrategies", () => {
  it("fails closed for production, where SDP has no confirmed deployment", async () => {
    // Sandbox (devnet) is deployed now, so only production still exercises the
    // no-deployment guard; devnet's read path is covered by the
    // `_listVaultStrategies` cases below, against stubbed RPC.
    await assert.rejects(
      client.listStrategies({ env: { SOLANA_RPC_URL: RPC_URL }, environment: "production" }),
      {
        code: "PROVIDER_NOT_CONFIGURED",
      }
    );
  });

  it("maps a vault to a snapshot", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET) }],
    });

    const snapshots = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);

    assert.deepEqual(snapshots, [
      {
        providerReference: VAULT_ADDRESS,
        name: "Veda USDC vault #7",
        sourceKind: "defi",
        depositMints: [USDC_DEVNET],
        shareMint: SHARE_MINT,
        hostCluster: "devnet",
        apyType: "variable",
        liquidityTerm: "instant",
        riskMetadata: { platformFeeBps: 25, performanceFeeBps: 1000 },
      },
    ]);
  });

  it("reports no rate rather than a fabricated one", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET) }],
    });
    const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
    assert.equal(only?.currentApy, undefined);
  });

  it("carries no curator, which SDP has no on-chain basis to attribute", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET) }],
    });
    const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
    assert.equal(only?.riskMetadata?.curator, undefined);
  });

  it("falls back to the vault id when the base asset is not a known token", async () => {
    stubRpc({
      accounts: [encodeBoringVault({ baseAsset: UNKNOWN_MINT, vaultId: 12n })],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET, { vaultId: 12n }) }],
    });
    const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
    assert.equal(only?.name, "Veda vault #12");
  });

  /** The fixture helper has to round-trip, or every assertion above is vacuous. */
  it("uses fixture addresses that survive an encode/decode round trip", () => {
    assert.equal(toBase58(decodeBase58(VAULT_ADDRESS)), VAULT_ADDRESS);
    assert.equal(decodeBase58(VAULT_ADDRESS).length, 32);
  });

  it("screens deposit mints against the vault's flags and the declared envelope", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [
        { pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET) },
        // Enabled on the vault, outside SDP's envelope.
        { pubkey: "asset-2", data: encodeAssetData(SOL_MINT) },
        // In SDP's envelope, right cluster, but the vault has deposits off.
        { pubkey: "asset-3", data: encodeAssetData(USDC_DEVNET, { allowDeposits: false }) },
      ],
    });

    const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
    assert.deepEqual(only?.depositMints, [USDC_DEVNET]);
  });

  /**
   * The screen is CLUSTER-AWARE, not symbol-level. Mainnet USDC and devnet
   * USDC share a symbol but are different mints; a devnet vault whose asset
   * config names the mainnet one (deposits ENABLED, so only the cluster check
   * can catch it) must not put a mint that does not exist on devnet into a
   * `hostCluster: "devnet"` row — the failure would otherwise surface only at
   * deposit build time as "account not found".
   */
  it("refuses the other cluster's mint of a declared symbol", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_MAINNET) }],
    });

    assert.deepEqual(await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT), []);
  });

  it("omits a vault with no deposit asset SDP fronts", async () => {
    stubRpc({
      accounts: [encodeBoringVault()],
      assets: [{ pubkey: "asset-1", data: encodeAssetData(SOL_MINT) }],
    });
    assert.deepEqual(await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT), []);
  });

  describe("liquidity", () => {
    const withAssets = (vault: Uint8Array) =>
      stubRpc({ accounts: [vault], assets: [{ pubkey: "a", data: encodeAssetData(USDC_DEVNET) }] });

    it("is instant only when redemption is permissionless and shares are unlocked", async () => {
      withAssets(encodeBoringVault());
      const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
      assert.equal(only?.liquidityTerm, "instant");
      assert.equal(only?.redemptionDelayDays, undefined);
    });

    it("is delayed when a named authority must sign the redemption", async () => {
      withAssets(encodeBoringVault({ withdrawAuthority: NAMED_AUTHORITY }));
      const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
      assert.equal(only?.liquidityTerm, "delayed");
    });

    it("is delayed with a day count, rounded up, when shares are locked", async () => {
      // 36 hours: a day and a half, which is two days before a holder can exit.
      withAssets(encodeBoringVault({ lockDurationSeconds: 129_600n }));
      const [only] = await client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT);
      assert.equal(only?.liquidityTerm, "delayed");
      assert.equal(only?.redemptionDelayDays, 2);
    });
  });

  describe("the shelf read is all-or-nothing", () => {
    /**
     * The catalogue sync DELETES rows a provider no longer lists, so a partial
     * read does not degrade — it delists whatever went unread. Every case here
     * must throw rather than return a short shelf.
     */
    it("throws when the RPC serves a different cluster", async () => {
      stubRpc({ genesis: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] });
      await assert.rejects(client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT), {
        code: "PROVIDER_NOT_CONFIGURED",
      });
    });

    it("proves the cluster BEFORE reading any account", async () => {
      const calls = stubRpc({ genesis: GENESIS_HASH_BY_CLUSTER["mainnet-beta"] });
      await assert.rejects(client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT));
      assert.deepEqual(
        calls.map((call) => call.method),
        ["getGenesisHash"]
      );
    });

    it("throws when a configured vault account does not exist", async () => {
      stubRpc({ accounts: [null] });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /does not exist/
      );
    });

    it("throws when a configured vault does not decode", async () => {
      const corrupted = encodeBoringVault();
      corrupted[0] = 0;
      stubRpc({ accounts: [corrupted] });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /layout has changed/
      );
    });

    it("throws when the account read returns a short list", async () => {
      stubRpc({ accounts: [] });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /configured vaults/
      );
    });

    /**
     * JSON-RPC reports failure inside a 200 body, so without this the HTTP
     * layer sees success and the read looks like an empty shelf.
     */
    it("throws on a JSON-RPC error body", async () => {
      stubRpc({ errorOn: "getMultipleAccounts", accounts: [encodeBoringVault()] });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /node behind/
      );
    });

    it("throws when an asset entry arrives without account data", async () => {
      stubRpc({
        accounts: [encodeBoringVault()],
        assets: [{ pubkey: "asset-1", data: encodeAssetData(USDC_DEVNET) }],
        stripAssetData: true,
      });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /returned no account data/
      );
    });

    it("throws when an asset account does not decode", async () => {
      const corrupted = encodeAssetData(USDC_DEVNET);
      corrupted[0] = 0;
      stubRpc({ accounts: [encodeBoringVault()], assets: [{ pubkey: "a", data: corrupted }] });
      await assert.rejects(
        client._listVaultStrategies(RPC_URL, "devnet", DEPLOYMENT),
        /did not decode/
      );
    });

    it("needs an RPC URL", async () => {
      await assert.rejects(client._listVaultStrategies("", "devnet", DEPLOYMENT), {
        code: "PROVIDER_NOT_CONFIGURED",
      });
    });
  });

  it("reads no accounts at all when the deployment lists no vaults", async () => {
    const calls = stubRpc({});
    const snapshots = await client._listVaultStrategies(RPC_URL, "devnet", {
      ...DEPLOYMENT,
      vaultStateAddresses: [],
    });
    assert.deepEqual(snapshots, []);
    assert.deepEqual(calls, []);
  });
});
