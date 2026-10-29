// biome-ignore-all lint/security/noSecrets: public Solana mint and authority addresses, verified against chain; not secrets.
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import {
  GENESIS_HASH_BY_CLUSTER,
  SOLANA_CLUSTERS,
  SPL_TOKEN_PROGRAMS,
} from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import type { Env } from "@/types/env";

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

/** A jsonParsed mint account as the RPC returns it, with the extensions that matter. */
function mintAccount(overrides: {
  owner?: string;
  hookProgram?: string | null;
  hookAuthority?: string | null;
  delegate?: string | null;
  dropHook?: boolean;
}) {
  const extensions: unknown[] = [
    { extension: "mintCloseAuthority", state: { closeAuthority: null } },
    { extension: "permanentDelegate", state: { delegate: overrides.delegate ?? PAXOS } },
    { extension: "tokenMetadata", state: { name: "PayPal USD", symbol: "PYUSD" } },
  ];
  if (!overrides.dropHook) {
    extensions.push({
      extension: "transferHook",
      state: {
        authority: overrides.hookAuthority === undefined ? PAXOS : overrides.hookAuthority,
        programId: overrides.hookProgram ?? null,
      },
    });
  }
  return {
    owner: overrides.owner ?? TOKEN_2022,
    lamports: 1,
    data: { program: "spl-token-2022", parsed: { type: "mint", info: { extensions } } },
  };
}

let poolSequence = 0;
/** Every request of the current test, by endpoint and method, in arrival order. */
const requests: { url: string; method: string }[] = [];
/** The jsonParsed account each mint answers with; null is an absent account. */
const accountFor = vi.fn<(mint: string) => unknown>();
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
        value: multipleAccountsParamsSchema.parse(params)[0].map((mint) => accountFor(mint)),
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
  it("reduces a parsed mint to owner, hook and delegate", () => {
    expect(observeMintState(mintAccount({}))).toEqual({
      owner: TOKEN_2022,
      transferHook: { programId: null, authority: PAXOS },
      permanentDelegate: PAXOS,
    });
  });

  it("reports a missing hook extension as undefined rather than null fields", () => {
    expect(observeMintState(mintAccount({ dropHook: true }))?.transferHook).toBeUndefined();
  });

  it("answers null for anything that is not a parsed mint", () => {
    expect(observeMintState(null)).toBeNull();
    expect(observeMintState({ owner: TOKEN_2022, data: ["AAAA", "base64"] })).toBeNull();
  });
});

describe("detectMintDrift", () => {
  const pinned = PINNED_TOKEN_2022_DEPOSIT_MINTS[PYUSD_MAINNET];

  it("is silent when every pinned field matches", () => {
    const observed = observeMintState(mintAccount({}));
    expect(observed && detectMintDrift(pinned, observed)).toEqual([]);
  });

  it("flags a hook program appearing where none was pinned", () => {
    const observed = observeMintState(
      mintAccount({ hookProgram: "Hook111111111111111111111111111111111111111" })
    );
    expect(observed && detectMintDrift(pinned, observed)).toEqual([
      {
        field: "transfer_hook_program",
        expected: null,
        actual: "Hook111111111111111111111111111111111111111",
      },
    ]);
  });

  it("flags an authority change, including the hook going immutable", () => {
    const observed = observeMintState(mintAccount({ hookAuthority: null }));
    expect(observed && detectMintDrift(pinned, observed)).toEqual([
      { field: "transfer_hook_authority", expected: PAXOS, actual: null },
    ]);
  });

  it("flags a delegate change and a missing hook extension independently", () => {
    const observed = observeMintState(
      mintAccount({ dropHook: true, delegate: "Some1111111111111111111111111111111111111111" })
    );
    expect(observed && detectMintDrift(pinned, observed).map((d) => d.field)).toEqual([
      "transfer_hook_extension",
      "permanent_delegate",
    ]);
  });

  it("flags a mint that is no longer owned by Token-2022", () => {
    const observed = observeMintState(mintAccount({ owner: SPL_TOKEN_PROGRAMS["spl-token"] }));
    expect(observed && detectMintDrift(pinned, observed).map((d) => d.field)).toEqual(["owner"]);
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

    await expect(guardIn("production", env)).resolves.toBe(1);

    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith("error", {
      event: EARN_DEPOSIT_MINT_DRIFT_EVENT,
      cluster: "mainnet-beta",
      symbol: "PYUSD",
      mint: PYUSD_MAINNET,
      field: "transfer_hook_program",
      expected: null,
      actual: "Hook111111111111111111111111111111111111111",
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
