// Checks every entry in the well-known token catalogue against chain.
// Run: `pnpm check:well-known-mints`
//
// For each token, and each cluster it declares a mint on, this fetches the mint
// account and asserts three things:
//
//   1. the account parses as a mint at all (not a token account, not a wallet)
//   2. its on-chain `decimals` matches the declared value
//   3. its owning program matches the declared `tokenProgram`
//
// Those are exactly the properties that are unsafe to take on trust. A spoofed
// token shares the real asset's name and symbol, and only the mint address
// distinguishes them; a wrong `decimals` silently misscales every amount shown
// for that token.
//
// Deliberately not wired into CI: it needs public RPC, and a rate-limited
// endpoint would make the pipeline flaky for no safety gain. Run it by hand
// whenever you add or change a catalogue entry.
//
// Run it through the root script, not with bare `node`. It imports the
// catalogue straight from TypeScript source, and `engines.node` here is
// `>=22.0.0` while unflagged type stripping only arrives in Node 23.6. Bare
// `node` would therefore fail on the Node 22 that CI itself uses, so the root
// script borrows the `tsx` that `@sdp/api` already depends on rather than
// adding one this workspace's release-age policy will not resolve.

import {
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKENS,
} from "../packages/sdp-types/src/well-known-tokens.ts";

const RPC_URLS = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Public RPC is rate limited; a short gap keeps a full run from being throttled. */
const REQUEST_SPACING_MS = 120;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAccount(cluster, address) {
  const response = await fetch(RPC_URLS[cluster], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "jsonParsed" }],
    }),
  });

  if (!response.ok) {
    throw new Error(`${cluster} RPC returned HTTP ${response.status}`);
  }

  const body = await response.json();
  return body.result?.value ?? null;
}

function findProblems(account, mint, tokenProgram) {
  if (!account) return ["no account exists at this address"];

  const problems = [];
  const parsedType = account.data?.parsed?.type;
  if (parsedType !== "mint") {
    problems.push(`account is a "${parsedType ?? "unparseable"}", not a mint`);
  }

  const onChainDecimals = account.data?.parsed?.info?.decimals;
  if (onChainDecimals !== mint.decimals) {
    problems.push(`declared decimals ${mint.decimals}, chain says ${onChainDecimals}`);
  }

  const expectedOwner = SPL_TOKEN_PROGRAMS[tokenProgram];
  if (account.owner !== expectedOwner) {
    problems.push(`declared ${tokenProgram}, chain says owner ${account.owner}`);
  }

  return problems;
}

const failures = [];
let verified = 0;

for (const [key, token] of Object.entries(WELL_KNOWN_TOKENS)) {
  for (const [cluster, mint] of Object.entries(token.mints)) {
    await delay(REQUEST_SPACING_MS);

    let problems;
    try {
      problems = findProblems(await fetchAccount(cluster, mint.address), mint, token.tokenProgram);
    } catch (error) {
      problems = [`lookup failed: ${error instanceof Error ? error.message : String(error)}`];
    }

    if (problems.length > 0) {
      const failure = `${key} on ${cluster}: ${problems.join("; ")}`;
      failures.push(failure);
      console.error(`FAIL  ${failure}`);
    } else {
      verified += 1;
      console.log(`ok    ${key} on ${cluster} — ${mint.decimals} decimals, ${token.tokenProgram}`);
    }
  }
}

console.log(`\n${verified} verified, ${failures.length} failed`);

if (failures.length > 0) {
  process.exitCode = 1;
}
