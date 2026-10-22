// Checks every entry in the well-known token catalogue against chain.
// Run: `pnpm check:well-known-mints`
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
//   6. it carries none of the three Token-2022 extensions payments refuse
//      (interest, scale or non-transferability): payment amount conversion
//      takes a catalogue mint's decimals without reading the chain, which is
//      exact only for a mint whose UI amount is its raw amount scaled by
//      decimals. Extensions are fixed at mint initialization, so this holds.
//
// 1 to 3 are unsafe to take on trust: a spoofed token shares the real asset's
// name and symbol, and only the mint distinguishes them; a wrong `decimals`
// silently misscales every amount shown for that token. 4 and 5 are the mint
// watch: PYUSD and USDG carry a transfer fee config (0 bps today) and a
// transfer hook extension (no program today). Until the token-movement builder
// lands, a fee would make every SDP transfer of the token underpay, and a hook
// would make every one fail. The fee is checked as `min(ceil(probe × bps ÷
// 10 000), maximumFee)`, not as bps alone, because `maximumFee` is 0 today.
// Each mint's other extension state is printed for the record.
//
// CI runs it only on pull requests that touch the catalogue or this script
// (`.github/workflows/well-known-mints.yml`): it needs public RPC, and a
// rate-limited endpoint would make every pipeline flaky for no safety gain. A
// scheduled run, which catches a fee or hook set after the entry merged, is a
// follow-up in ADR 0012.
//
// Run it through the root script, not with bare `node`. It imports the
// catalogue and the decoder straight from TypeScript source, and
// `engines.node` here is `>=24.0.0`. Keep using the workspace `tsx` command so
// this check follows the same TypeScript execution path as the API tooling
// without adding another dependency that the workspace release-age policy
// would need to resolve.

import { baseUnits, U64_MAX } from "../packages/sdp-solana/src/token-amount.ts";
import { decodeTokenTerms, feeFor } from "../packages/sdp-solana/src/token-terms.ts";
import { WELL_KNOWN_TOKENS } from "../packages/sdp-types/src/well-known-tokens.ts";

const RPC_URLS = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

const SYSVAR_CLOCK_ADDRESS = "SysvarC1ock11111111111111111111111111111111";

/** A payment-sized transfer, in whole tokens. Any amount above 0 shows a fee that is on. */
const PROBE_TOKENS = 1_000n;

/** Public RPC is rate limited; a short gap keeps a full run from being throttled. */
const REQUEST_SPACING_MS = 120;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One base64 account from a `getMultipleAccounts` answer, as kit's `EncodedAccount`. */
function encodedAccount(address, account) {
  return {
    address,
    data: Uint8Array.from(Buffer.from(account.data[0], "base64")),
    executable: account.executable,
    lamports: BigInt(account.lamports),
    programAddress: account.owner,
    space: BigInt(account.space),
  };
}

/** The mint and the Clock sysvar, read in one request; the mint is null when absent. */
async function fetchMintAndClock(cluster, address) {
  const response = await fetch(RPC_URLS[cluster], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [[address, SYSVAR_CLOCK_ADDRESS], { encoding: "base64" }],
    }),
  });

  if (!response.ok) {
    throw new Error(`${cluster} RPC returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(`${cluster} RPC error: ${body.error.message}`);
  }
  const [mint, clock] = body.result.value;
  if (clock === null) {
    throw new Error(`${cluster} RPC returned no Clock sysvar`);
  }
  return {
    mint: mint === null ? null : encodedAccount(address, mint),
    clock: encodedAccount(SYSVAR_CLOCK_ADDRESS, clock),
  };
}

function describeFee(rate) {
  return `${rate.basisPoints} bps, max ${rate.maximumFee}, from epoch ${rate.epoch}`;
}

/** The terms worth recording, one line per kind of state. */
function describeTerms(terms) {
  const lines = [];
  if (terms.transferFee !== null) {
    lines.push(`transfer fee: older ${describeFee(terms.transferFee.older)}`);
    lines.push(`              newer ${describeFee(terms.transferFee.newer)}`);
  }
  if (terms.display.kind !== "plain") {
    lines.push(
      `display: ${JSON.stringify(terms.display, (_, value) => (typeof value === "bigint" ? `${value}` : value))}`
    );
  }
  const flags = [
    terms.requiredAccountExtensions.some(
      (extension) => extension.__kind === "TransferHookAccount"
    ) && `transfer hook ${terms.transferHookProgram ?? "(no program)"}`,
    terms.paused && "paused",
    terms.nonTransferable && "non-transferable",
    terms.defaultAccountState === "frozen" && "accounts open frozen",
    terms.permanentDelegate !== null && `permanent delegate ${terms.permanentDelegate}`,
    terms.confidentialTransfers && "confidential transfers",
    terms.mintCloseAuthority !== null && `close authority ${terms.mintCloseAuthority}`,
    terms.freezeAuthority !== null && `freeze authority ${terms.freezeAuthority}`,
  ].filter(Boolean);
  if (flags.length > 0) {
    lines.push(flags.join("; "));
  }
  return lines;
}

function findProblems(accounts, mint, tokenProgram) {
  if (accounts.mint === null) {
    return { problems: ["no account exists at this address"], details: [] };
  }

  let terms;
  try {
    terms = decodeTokenTerms(
      { kind: "token", mint: mint.address, program: tokenProgram },
      { mint: accounts.mint, clock: accounts.clock }
    );
  } catch (error) {
    return { problems: [error instanceof Error ? error.message : String(error)], details: [] };
  }

  const problems = [];
  if (terms.decimals !== mint.decimals) {
    problems.push(`declared decimals ${mint.decimals}, chain says ${terms.decimals}`);
  }

  const probeUnits = PROBE_TOKENS * 10n ** BigInt(terms.decimals);
  const probe = baseUnits(probeUnits < U64_MAX ? probeUnits : U64_MAX);
  if (terms.transferFee !== null) {
    const epochs = [
      ["current", terms.readAt.epoch],
      ["newer", terms.transferFee.newer.epoch],
    ];
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

  if (terms.display.kind !== "plain") {
    problems.push(`carries ${terms.display.kind} display, which payments do not support`);
  }
  if (terms.nonTransferable) {
    problems.push("is non-transferable, which payments do not support");
  }

  return { problems, details: describeTerms(terms) };
}

const failures = [];
let verified = 0;

for (const [key, token] of Object.entries(WELL_KNOWN_TOKENS)) {
  for (const [cluster, mint] of Object.entries(token.mints)) {
    await delay(REQUEST_SPACING_MS);

    let result;
    try {
      result = findProblems(
        await fetchMintAndClock(cluster, mint.address),
        mint,
        token.tokenProgram
      );
    } catch (error) {
      result = {
        problems: [`lookup failed: ${error instanceof Error ? error.message : String(error)}`],
        details: [],
      };
    }

    if (result.problems.length > 0) {
      const failure = `${key} on ${cluster}: ${result.problems.join("; ")}`;
      failures.push(failure);
      console.error(`FAIL  ${failure}`);
    } else {
      verified += 1;
      console.log(`ok    ${key} on ${cluster} — ${mint.decimals} decimals, ${token.tokenProgram}`);
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
