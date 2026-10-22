// biome-ignore-all lint/security/noSecrets: public Solana mint and authority addresses, verified against chain; not secrets.
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  GENESIS_HASH_BY_CLUSTER,
  SOLANA_CLUSTERS,
  SPL_TOKEN_PROGRAMS,
} from "@sdp/types/well-known-tokens";
import { address, type EncodedAccount, getBase64Encoder, lamports } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type JsonRpcResult, parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import { CLOCK_RPC_ACCOUNT, mintRpcAccount } from "@/test/helpers/token-movement";
import type { Env } from "@/types/env";
import type { ObservedMintState } from "./deposit-mint-guard";

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));

/** `getMultipleAccounts` params: the mint addresses, then the read config. */
const multipleAccountsParamsSchema = z.tuple([z.array(z.string()), z.unknown()]);

vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent: mocks.logEvent,
}));

const {
  EARN_DEPOSIT_MINT_DRIFT_EVENT,
  EARN_DEPOSIT_MINT_GUARD_SKIPPED_EVENT,
  PINNED_TOKEN_2022_DEPOSIT_MINTS,
  detectMintDrift,
  guardDepositMints,
  observeMintState,
  token2022DepositMints,
} = await import("./deposit-mint-guard");

const env = { DATABASE_URL: "postgres://unit" } as Env;
const earnEnabledEnv = {
  ...env,
  MARKETS_ENABLED: "true",
  EARN_ENABLED: "true",
  SDP_RELEASE_CHANNEL: "experimental",
} as Env;
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];
const PYUSD_MAINNET = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const PAXOS = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";

const UNSET = "11111111111111111111111111111111";

/** What a test mint varies: null is an unset authority or program. */
interface TestMintOptions {
  hookProgram: string | null;
  hookAuthority: string | null;
  delegate: string | null;
  dropHook: boolean;
  feeBasisPoints: number;
}

/** PYUSD as mainnet holds it: Paxos's authorities, no hook program, no fee. */
const PYUSD_LIKE: TestMintOptions = {
  hookProgram: null,
  hookAuthority: PAXOS,
  delegate: PAXOS,
  dropHook: false,
  feeBasisPoints: 0,
};

/** A base64 PYUSD-like mint as one read returns it, with the extensions that matter. */
function mintAccount(overrides: Partial<TestMintOptions>) {
  const mint: TestMintOptions = { ...PYUSD_LIKE, ...overrides };
  const fee = {
    epoch: 0n,
    maximumFee: 1_000_000n,
    transferFeeBasisPoints: mint.feeBasisPoints,
  };
  const extensions: ExtensionArgs[] = [
    {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: address(PAXOS),
      withdrawWithheldAuthority: address(PAXOS),
      withheldAmount: 0n,
      olderTransferFee: fee,
      newerTransferFee: fee,
    },
    { __kind: "MintCloseAuthority", closeAuthority: address(UNSET) },
    {
      __kind: "PermanentDelegate",
      delegate: address(mint.delegate === null ? UNSET : mint.delegate),
    },
  ];
  if (!mint.dropHook) {
    extensions.push({
      __kind: "TransferHook",
      authority: address(mint.hookAuthority === null ? UNSET : mint.hookAuthority),
      programId: address(mint.hookProgram === null ? UNSET : mint.hookProgram),
    });
  }
  return mintRpcAccount("token-2022", { decimals: 6, extensions });
}

/** The encoded accounts `observeMintState` takes, from wire-format accounts. */
function encoded(at: string, account: JsonRpcResult): EncodedAccount {
  const parsed = z
    .object({ data: z.tuple([z.string(), z.literal("base64")]), owner: z.string() })
    .parse(account);
  const data = new Uint8Array(getBase64Encoder().encode(parsed.data[0]));
  return {
    address: address(at),
    data,
    executable: false,
    lamports: lamports(1n),
    programAddress: address(parsed.owner),
    space: BigInt(data.length),
  };
}

const CLOCK = encoded(SYSVAR_CLOCK_ADDRESS, CLOCK_RPC_ACCOUNT);

/** The observed state a pinned mint shows, for the pure drift rules. */
const MATCHING: ObservedMintState = {
  owner: TOKEN_2022,
  transferHook: { programId: null, authority: PAXOS },
  permanentDelegate: PAXOS,
  earnRefusal: null,
};

let poolSequence = 0;
/** Every request of the current test, by endpoint and method, in arrival order. */
const requests: { url: string; method: string }[] = [];
/** The base64 account each mint answers with; null is an absent account. */
const accountFor = vi.fn<(mint: string) => JsonRpcResult | null>();
/** Set to make the next `getMultipleAccounts` answer an HTTP error. */
let failNextRead = false;

function poolUrl(cluster: "devnet" | "mainnet"): string {
  return `https://${cluster}-${poolSequence}.mint-guard.test`;
}

/** How stage and prod run: a devnet process default and no mainnet override. */
function stubDevnetDefaultProcess(): void {
  vi.stubEnv("SOLANA_NETWORK", "devnet");
  vi.stubEnv("SOLANA_RPC_URL", poolUrl("devnet"));
  vi.stubEnv("SOLANA_MAINNET_RPC_URL", "");
}

beforeEach(() => {
  vi.clearAllMocks();
  poolSequence += 1;
  requests.length = 0;
  failNextRead = false;
  accountFor.mockReset().mockImplementation((mint) => {
    const pinned = PINNED_TOKEN_2022_DEPOSIT_MINTS[mint];
    return pinned
      ? mintAccount({
          hookProgram: pinned.transferHookProgram,
          hookAuthority: pinned.transferHookAuthority,
          delegate: pinned.permanentDelegate,
        })
      : null;
  });
  vi.stubEnv("SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL", poolUrl("devnet"));
  vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", poolUrl("mainnet"));
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method, params } = parseJsonRpcRequest(init);
    const url = String(input);
    requests.push({ url, method });
    if (method === "getGenesisHash") {
      const cluster = url === poolUrl("mainnet") ? "mainnet-beta" : "devnet";
      return Response.json({ jsonrpc: "2.0", id, result: GENESIS_HASH_BY_CLUSTER[cluster] });
    }
    if (failNextRead) {
      failNextRead = false;
      return new Response("Too Many Requests", { status: 429 });
    }
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: {
        context: { slot: 1 },
        value: multipleAccountsParamsSchema
          .parse(params)[0]
          .map((at) => (at === SYSVAR_CLOCK_ADDRESS ? CLOCK_RPC_ACCOUNT : accountFor(at))),
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** One guard pass, as the metrics refresh runs it: inside the environment's cluster scope. */
function guardIn(environment: SdpEnvironment, guardEnv: Env): Promise<number> {
  return runInClusterScope({ projectId: null, environment }, () => guardDepositMints(guardEnv));
}

describe("pins", () => {
  it.each(SOLANA_CLUSTERS)("cover every Token-2022 deposit mint on %s", (cluster) => {
    const mints = token2022DepositMints(cluster);
    // Guards the guard: PYUSD and USDG are Token-2022 on both clusters today.
    expect(mints.length).toBeGreaterThanOrEqual(2);
    const unpinned = mints.filter(({ mint }) => !PINNED_TOKEN_2022_DEPOSIT_MINTS[mint]);
    expect(unpinned, "pin the new mint's extension state in deposit-mint-guard.ts").toEqual([]);
  });

  it("do not include classic SPL deposit mints", () => {
    expect(token2022DepositMints("mainnet-beta").map(({ symbol }) => symbol)).not.toContain("USDC");
  });
});

describe("observeMintState", () => {
  it("reduces a mint to owner, hook, delegate and the Earn row's answer", () => {
    expect(observeMintState(encoded(PYUSD_MAINNET, mintAccount({})), CLOCK)).toEqual(MATCHING);
  });

  it("reports a missing hook extension as undefined rather than null fields", () => {
    expect(
      observeMintState(encoded(PYUSD_MAINNET, mintAccount({ dropHook: true })), CLOCK)?.transferHook
    ).toBeUndefined();
  });

  it("asks the Earn row: a charged fee or a hook program set is refused", () => {
    expect(
      observeMintState(encoded(PYUSD_MAINNET, mintAccount({ feeBasisPoints: 25 })), CLOCK)
        ?.earnRefusal
    ).toBe("transfer_fee");
    expect(
      observeMintState(
        encoded(
          PYUSD_MAINNET,
          mintAccount({ hookProgram: "Hook111111111111111111111111111111111111111" })
        ),
        CLOCK
      )?.earnRefusal
    ).toBe("transfer_hook");
  });

  it("answers null for anything that is not a mint", () => {
    expect(
      observeMintState(
        encoded(PYUSD_MAINNET, { data: ["AAAA", "base64"], owner: TOKEN_2022 }),
        CLOCK
      )
    ).toBeNull();
  });
});

describe("detectMintDrift", () => {
  const pinned = PINNED_TOKEN_2022_DEPOSIT_MINTS[PYUSD_MAINNET];

  it("is silent when every pinned field matches", () => {
    expect(detectMintDrift(pinned, MATCHING)).toEqual([]);
  });

  it("flags a hook program appearing where none was pinned", () => {
    expect(
      detectMintDrift(pinned, {
        ...MATCHING,
        transferHook: {
          programId: "Hook111111111111111111111111111111111111111",
          authority: PAXOS,
        },
      })
    ).toEqual([
      {
        field: "transfer_hook_program",
        expected: null,
        actual: "Hook111111111111111111111111111111111111111",
      },
    ]);
  });

  it("flags an authority change, including the hook going immutable", () => {
    expect(
      detectMintDrift(pinned, { ...MATCHING, transferHook: { programId: null, authority: null } })
    ).toEqual([{ field: "transfer_hook_authority", expected: PAXOS, actual: null }]);
  });

  it("flags a delegate change and a missing hook extension independently", () => {
    expect(
      detectMintDrift(pinned, {
        ...MATCHING,
        transferHook: undefined,
        permanentDelegate: "Some1111111111111111111111111111111111111111",
      }).map((d) => d.field)
    ).toEqual(["transfer_hook_extension", "permanent_delegate"]);
  });

  it("flags a mint that is no longer owned by Token-2022", () => {
    expect(
      detectMintDrift(pinned, { ...MATCHING, owner: SPL_TOKEN_PROGRAMS["spl-token"] }).map(
        (d) => d.field
      )
    ).toEqual(["owner"]);
  });

  it("flags a mint the Earn row refuses", () => {
    expect(detectMintDrift(pinned, { ...MATCHING, earnRefusal: "paused" })).toEqual([
      { field: "earn_support", expected: "supported", actual: "paused" },
    ]);
  });
});

describe("guardDepositMints", () => {
  it.each([
    ["sandbox", "devnet", "devnet"],
    ["production", "mainnet-beta", "mainnet"],
  ] as const)(
    "reads every pinned mint of the %s scope's cluster (%s) in one request, from its pool",
    async (environment, cluster, pool) => {
      await expect(guardIn(environment, env)).resolves.toBe(0);

      expect(requests).toEqual([
        { url: poolUrl(pool), method: "getGenesisHash" },
        { url: poolUrl(pool), method: "getMultipleAccounts" },
      ]);
      expect(accountFor.mock.calls.map(([mint]) => mint)).toEqual(
        token2022DepositMints(cluster).map(({ mint }) => mint)
      );
      expect(mocks.logEvent).not.toHaveBeenCalled();
    }
  );

  it("reads mainnet from the mainnet pool on a devnet-default process", async () => {
    stubDevnetDefaultProcess();

    await expect(guardIn("production", earnEnabledEnv)).resolves.toBe(0);

    expect(new Set(requests.map(({ url }) => url))).toEqual(new Set([poolUrl("mainnet")]));
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("emits one drift event per changed field, naming cluster, symbol and mint", async () => {
    accountFor.mockImplementation((mint) =>
      mint === PYUSD_MAINNET
        ? mintAccount({ hookProgram: "Hook111111111111111111111111111111111111111" })
        : mintAccount({})
    );

    // The pin and the Earn row both see the hook program.
    await expect(guardIn("production", env)).resolves.toBe(2);

    expect(mocks.logEvent).toHaveBeenCalledTimes(2);
    expect(mocks.logEvent).toHaveBeenCalledWith("error", {
      event: EARN_DEPOSIT_MINT_DRIFT_EVENT,
      cluster: "mainnet-beta",
      symbol: "PYUSD",
      mint: PYUSD_MAINNET,
      field: "transfer_hook_program",
      expected: null,
      actual: "Hook111111111111111111111111111111111111111",
    });
    expect(mocks.logEvent).toHaveBeenCalledWith("error", {
      event: EARN_DEPOSIT_MINT_DRIFT_EVENT,
      cluster: "mainnet-beta",
      symbol: "PYUSD",
      mint: PYUSD_MAINNET,
      field: "earn_support",
      expected: "supported",
      actual: "transfer_hook",
    });
  });

  it.each([
    ["error", "enabled", earnEnabledEnv],
    ["info", "disabled", { ...env, SDP_RELEASE_CHANNEL: "experimental" } as Env],
    ["error", "unreadable", env],
  ] as const)(
    "logs a skip at %s where Earn is %s when the cluster has no pool, never reading another",
    async (level, _state, guardEnv) => {
      stubDevnetDefaultProcess();
      vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");

      await expect(guardIn("production", guardEnv)).resolves.toBe(0);

      expect(requests).toEqual([]);
      expect(mocks.logEvent).toHaveBeenCalledOnce();
      expect(mocks.logEvent).toHaveBeenCalledWith(
        level,
        expect.objectContaining({
          event: EARN_DEPOSIT_MINT_GUARD_SKIPPED_EVENT,
          cluster: "mainnet-beta",
          error_code: "RPC_NOT_CONFIGURED",
        })
      );
    }
  );

  it("treats a failed or unparseable read as a warning, never as drift", async () => {
    failNextRead = true;
    await expect(guardIn("production", env)).resolves.toBe(0);

    accountFor.mockReturnValue(null);
    await expect(guardIn("production", env)).resolves.toBe(0);

    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
