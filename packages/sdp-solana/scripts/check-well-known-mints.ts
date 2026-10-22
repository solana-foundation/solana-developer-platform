// Checks every entry in the well-known token catalogue against chain.
// Run: `pnpm check:well-known-mints` from the repository root.
//
// For each token, and each cluster it declares a mint on, this reads the mint
// account and the Clock sysvar in one `getMultipleAccounts` request, decodes
// them with the same Token Terms decoder the API uses (ADR 0012), and asserts:
//
//   1. the account is an initialized mint (not a token account, not a wallet)
//   2. its owning program matches the declared `tokenProgram`
//   3. its on-chain `decimals` matches the declared value
//   4. a transfer of PROBE_TOKENS pays no fee, under the fee entry of the
//      current epoch and under the newer entry (a fee change takes effect two
//      epochs after it is set, so the newer entry is the early warning)
//   5. no transfer hook program is set
//   6. it is not non-transferable: a catalogue token that cannot move has no
//      place in a payments catalogue. Interest-bearing and scaled mints pass:
//      every payment path reads the mint's terms live and moves token units,
//      so a display rule never changes what moves (ADR 0012).
//
// 1 to 3 are unsafe to take on trust: a spoofed token shares the real asset's
// name and symbol, and only the mint distinguishes them; a wrong `decimals`
// silently misscales every amount shown for that token. 4 and 5 are the mint
// watch: PYUSD and USDG carry a transfer fee config (0 bps today) and a
// transfer hook extension (no program today). The builder quotes a fee and
// resolves a hook, but a change on a catalogue token changes what every one
// of its transfers costs or needs, so it is worth knowing the day it happens.
// The fee is checked as `min(ceil(probe × bps ÷ 10 000), maximumFee)`, not
// as bps alone, because `maximumFee` is 0 today.
// Each mint's other extension state is printed for the record.
//
// CI runs it on pull requests that touch the catalogue, the decoder or this
// script (`.github/workflows/well-known-mints.yml`), and daily
// (`.github/workflows/well-known-mints-watch.yml`), which alerts on any failure
// here: a fee or a hook set after an entry merged. No other pull request runs
// it: it needs public RPC, and a rate-limited endpoint would make every
// pipeline flaky for no safety gain.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOLANA_CLUSTERS,
  type SolanaCluster,
  type TokenProgramKind,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
  type WellKnownTokenMint,
} from "@sdp/types/well-known-tokens";
import { address, createSolanaRpc, type EncodedAccount, fetchEncodedAccounts } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { baseUnits, U64_MAX } from "#/token-amount";
import {
  type DisplayRule,
  decodeTokenTerms,
  feeFor,
  type MintTokenTerms,
  type TransferFeeRate,
} from "#/token-terms";

const RPCS = {
  devnet: createSolanaRpc("https://api.devnet.solana.com"),
  "mainnet-beta": createSolanaRpc("https://api.mainnet-beta.solana.com"),
} as const satisfies Record<SolanaCluster, ReturnType<typeof createSolanaRpc>>;

/** A payment-sized transfer, in whole tokens. Any amount above 0 shows a fee that is on. */
const PROBE_TOKENS = 1_000n;

/** Public RPC is rate limited; a short gap keeps a full run from being throttled. */
const REQUEST_SPACING_MS = 120;

type MintAndClock = Readonly<{ mint: EncodedAccount | null; clock: EncodedAccount }>;

type Findings = Readonly<{ problems: string[]; details: string[] }>;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The mint and the Clock sysvar, read in one request; the mint is null when absent. */
async function fetchMintAndClock(cluster: SolanaCluster, mint: string): Promise<MintAndClock> {
  const [mintAccount, clock] = await fetchEncodedAccounts(RPCS[cluster], [
    address(mint),
    SYSVAR_CLOCK_ADDRESS,
  ]);
  if (!clock.exists) {
    throw new Error(`${cluster} RPC returned no Clock sysvar`);
  }
  return { mint: mintAccount.exists ? mintAccount : null, clock };
}

function describeFee(rate: TransferFeeRate): string {
  return `${rate.basisPoints} bps, max ${rate.maximumFee}, from epoch ${rate.epoch}`;
}

function describeDisplay(rule: DisplayRule): string | null {
  switch (rule.kind) {
    case "plain":
      return null;
    case "scaled":
      return `display: scaled ×${rule.multiplier}, ×${rule.newMultiplier} from ${rule.newMultiplierEffectiveAt}`;
    case "interest":
      return `display: interest ${rule.preUpdateAverageRate} bps average to ${rule.lastUpdateAt}, ${rule.currentRate} bps since`;
    default: {
      const exhaustive: never = rule;
      throw new Error(`Unknown display rule: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The terms worth recording, one line per kind of state. */
function describeTerms(terms: MintTokenTerms): string[] {
  const lines: string[] = [];
  if (terms.transferFee !== null) {
    lines.push(`transfer fee: older ${describeFee(terms.transferFee.older)}`);
    lines.push(`              newer ${describeFee(terms.transferFee.newer)}`);
  }
  const display = describeDisplay(terms.display);
  if (display !== null) {
    lines.push(display);
  }
  const flags: string[] = [];
  if (
    terms.requiredAccountExtensions.some((extension) => extension.__kind === "TransferHookAccount")
  ) {
    flags.push(
      `transfer hook ${terms.transferHookProgram === null ? "(no program)" : terms.transferHookProgram}`
    );
  }
  if (terms.paused) flags.push("paused");
  if (terms.nonTransferable) flags.push("non-transferable");
  if (terms.defaultAccountState === "frozen") flags.push("accounts open frozen");
  if (terms.permanentDelegate !== null) flags.push(`permanent delegate ${terms.permanentDelegate}`);
  if (terms.confidentialTransfers) flags.push("confidential transfers");
  if (terms.mintCloseAuthority !== null) flags.push(`close authority ${terms.mintCloseAuthority}`);
  if (terms.freezeAuthority !== null) flags.push(`freeze authority ${terms.freezeAuthority}`);
  if (flags.length > 0) {
    lines.push(flags.join("; "));
  }
  return lines;
}

export function findProblems(
  accounts: MintAndClock,
  mint: WellKnownTokenMint,
  tokenProgram: TokenProgramKind
): Findings {
  if (accounts.mint === null) {
    return { problems: ["no account exists at this address"], details: [] };
  }

  let terms: MintTokenTerms;
  try {
    terms = decodeTokenTerms(
      { kind: "token", mint: address(mint.address), program: tokenProgram },
      { mint: accounts.mint, clock: accounts.clock }
    );
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)], details: [] };
  }

  const problems: string[] = [];
  if (terms.decimals !== mint.decimals) {
    problems.push(`declared decimals ${mint.decimals}, chain says ${terms.decimals}`);
  }

  const probeUnits = PROBE_TOKENS * 10n ** BigInt(terms.decimals);
  const probe = baseUnits(probeUnits < U64_MAX ? probeUnits : U64_MAX);
  if (terms.transferFee !== null) {
    const epochs = [
      ["current", terms.readAt.epoch],
      ["newer", terms.transferFee.newer.epoch],
    ] as const;
    for (const [label, epoch] of epochs) {
      const fee = feeFor(terms, probe, epoch);
      if (fee > 0n) {
        problems.push(
          `the ${label} fee entry (epoch ${epoch}) takes ${fee} base units from a ${PROBE_TOKENS}-token transfer`
        );
      }
    }
  }
  if (terms.transferHookProgram !== null) {
    problems.push(`a transfer hook program is set: ${terms.transferHookProgram}`);
  }
  if (terms.nonTransferable) {
    problems.push("is non-transferable, which payments do not support");
  }

  return { problems, details: describeTerms(terms) };
}

async function checkMint(
  cluster: SolanaCluster,
  mint: WellKnownTokenMint,
  tokenProgram: TokenProgramKind
): Promise<Findings> {
  try {
    return findProblems(await fetchMintAndClock(cluster, mint.address), mint, tokenProgram);
  } catch (error) {
    return {
      problems: [`lookup failed: ${error instanceof Error ? error.message : String(error)}`],
      details: [],
    };
  }
}

async function main(): Promise<void> {
  const tokens: [string, WellKnownToken][] = Object.entries(WELL_KNOWN_TOKENS);
  const failures: string[] = [];
  let verified = 0;

  for (const [key, token] of tokens) {
    for (const cluster of SOLANA_CLUSTERS) {
      const mint = token.mints[cluster];
      if (mint === undefined) continue;
      await delay(REQUEST_SPACING_MS);

      const result = await checkMint(cluster, mint, token.tokenProgram);
      if (result.problems.length > 0) {
        const failure = `${key} on ${cluster}: ${result.problems.join("; ")}`;
        failures.push(failure);
        console.error(`FAIL  ${failure}`);
      } else {
        verified += 1;
        console.log(
          `ok    ${key} on ${cluster} — ${mint.decimals} decimals, ${token.tokenProgram}`
        );
      }
      for (const line of result.details) {
        console.log(`        ${line}`);
      }
    }
  }

  console.log(`\n${verified} verified, ${failures.length} failed`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

// Tests import `findProblems`; only a direct run reads the chain.
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  await main();
}
