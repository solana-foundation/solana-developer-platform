// biome-ignore-all lint/security/noSecrets: public Solana mint and authority addresses, verified against chain; not secrets.
import { SOLANA_CLUSTERS, SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installClusterRpcResponder,
  type JsonRpcResult,
  runInJobClusterScope,
} from "@/test/helpers/cluster-rpc";

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
}));

vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent: mocks.logEvent,
}));

const {
  EARN_DEPOSIT_MINT_DRIFT_EVENT,
  PINNED_TOKEN_2022_DEPOSIT_MINTS,
  detectMintDrift,
  guardDepositMints,
  observeMintState,
  token2022DepositMints,
} = await import("./deposit-mint-guard");

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
  const extensions: JsonRpcResult[] = [
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

beforeEach(() => {
  vi.clearAllMocks();
});

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
  const stub = installClusterRpcResponder();
  const HOOK_PROGRAM = "Hook111111111111111111111111111111111111111";

  function guardMainnet(): Promise<number> {
    return runInJobClusterScope("production", guardDepositMints);
  }

  function mintReads() {
    return stub.calls.filter((call) => call.method === "getAccountInfo");
  }

  it("emits nothing when every mainnet mint matches its pin", async () => {
    stub.answer("getAccountInfo", { context: { slot: 1 }, value: mintAccount({}) });

    await expect(guardMainnet()).resolves.toBe(0);

    expect(mintReads()).toEqual(
      token2022DepositMints("mainnet-beta").map(() => ({
        cluster: "mainnet-beta",
        method: "getAccountInfo",
      }))
    );
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("emits one drift event per changed field, naming cluster, symbol and mint", async () => {
    stub.respond("getAccountInfo", (request) => ({
      result: {
        context: { slot: 1 },
        value:
          request.params[0] === PYUSD_MAINNET
            ? mintAccount({ hookProgram: HOOK_PROGRAM })
            : mintAccount({}),
      },
    }));

    await expect(guardMainnet()).resolves.toBe(1);

    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith("error", {
      event: EARN_DEPOSIT_MINT_DRIFT_EVENT,
      cluster: "mainnet-beta",
      symbol: "PYUSD",
      mint: PYUSD_MAINNET,
      field: "transfer_hook_program",
      expected: null,
      actual: HOOK_PROGRAM,
    });
  });

  it("skips quietly when this deployment has no RPC for the cluster", async () => {
    vi.stubEnv("SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL", "");

    await expect(guardMainnet()).resolves.toBe(0);

    expect(stub.calls).toEqual([]);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("treats a failed or unparseable read as a warning, never as drift", async () => {
    stub.respond("getAccountInfo", (request) =>
      request.params[0] === PYUSD_MAINNET
        ? { error: { code: -32603, message: "Internal error" } }
        : { result: { context: { slot: 1 }, value: null } }
    );

    await expect(guardMainnet()).resolves.toBe(0);

    expect(mintReads()).toHaveLength(token2022DepositMints("mainnet-beta").length);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
