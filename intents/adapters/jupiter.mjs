// The Jupiter swap wrapper: an endpoint for remote recipes (DESIGN.md, 4.16) that asks Jupiter's
// public API for a route. Neither the service nor the signer trusts it. The planner simulates what
// it returns, and Lighthouse asserts the intent's postconditions onchain.
//
//   node adapters/jupiter.mjs            listens on 127.0.0.1:8791
//
// POST /jupiter answers a remote call. POST /mode with { "malicious": true } makes each answer
// also approve a delegate on the owner's input token account, so that the planner refuses the plan
// for its `noAuthorityChange` postcondition. The playground uses that switch.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8791);
const JUPITER = process.env.JUPITER_API ?? "https://lite-api.jup.ag/swap/v1";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/// Jupiter routes with lookup tables. A v1 transaction has none, so a route must fit the account
/// limit with every account in the message.
const MAX_ACCOUNTS = 24;
const SLIPPAGE_BPS = 50;
const ATTACKER = "Attacker11111111111111111111111111111111111";

let malicious = false;

/// The answer to each recent call, by its body. A CLI and a service that plan one intent send the
/// same call seconds apart, and Jupiter's public API limits its rate. The planner checks a reused
/// answer as it checks any answer, and Lighthouse bounds what it can do.
const ANSWER_LIFETIME_MS = 15_000;
const recent = new Map();

/// Jupiter's public API limits its rate, so a 429 waits and tries again. Any other failure names
/// Jupiter's status and answer.
async function jupiter(path, init) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${JUPITER}${path}`, init);

    if (response.status === 429 && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }

    const text = await response.text();

    if (!response.ok) throw Object.assign(new Error(`Jupiter answered ${response.status}: ${text}`), { status: 502 });

    return JSON.parse(text);
  }
}

/// What each interface swaps: the mint in, the mint out, the amount in, and the least out.
const LEGS = {
  "vault.deposit": (inputs) => ({ from: inputs.asset, to: inputs.vault, amount: inputs.amount, least: inputs.minShares }),
  "vault.withdraw": (inputs) => ({ from: inputs.vault, to: inputs.asset, amount: inputs.shares, least: inputs.minAmount }),
};

const ROLES = { "false,false": 0, "false,true": 1, "true,false": 2, "true,true": 3 };

function instruction({ programId, accounts, data }) {
  return {
    programAddress: programId,
    accounts: accounts.map(({ pubkey, isSigner, isWritable }) => ({ address: pubkey, role: ROLES[`${isSigner},${isWritable}`] })),
    data,
  };
}

/// SPL Token `Approve` of the whole amount to the attacker, on the account that the swap spends.
function approval(source, owner, amount) {
  const data = Buffer.alloc(9);
  data.writeUInt8(4, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);

  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: 1 },
      { address: ATTACKER, role: 0 },
      { address: owner, role: 2 },
    ],
    data: data.toString("base64"),
  };
}

async function answer(call) {
  const leg = LEGS[call.interface?.name]?.(call.inputs ?? {});

  if (!leg) throw Object.assign(new Error(`no route for the interface ${call.interface?.name}`), { status: 422 });

  const query = new URLSearchParams({
    inputMint: leg.from,
    outputMint: leg.to,
    amount: leg.amount,
    slippageBps: String(SLIPPAGE_BPS),
    maxAccounts: String(MAX_ACCOUNTS),
  });
  const quote = await jupiter(`/quote?${query}`);

  if (quote.error || !quote.outAmount) throw Object.assign(new Error(`Jupiter has no route: ${JSON.stringify(quote)}`), { status: 422 });
  if (BigInt(quote.outAmount) < BigInt(leg.least)) {
    throw Object.assign(new Error(`the route pays ${quote.outAmount}, below ${leg.least}`), { status: 422 });
  }

  const swap = await jupiter("/swap-instructions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: call.inputs.owner,
      payer: call.payers.rent,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: false,
    }),
  });

  if (swap.error) throw Object.assign(new Error(`Jupiter refused the swap: ${swap.error}`), { status: 502 });

  // A v1 transaction holds its budget in the header, so the ComputeBudget instructions go.
  const instructions = [...swap.setupInstructions, swap.swapInstruction, swap.cleanupInstruction, ...swap.otherInstructions]
    .filter(Boolean)
    .map(instruction);

  if (malicious) {
    const source = swap.swapInstruction.accounts[2].pubkey;
    instructions.push(approval(source, call.inputs.owner, leg.amount));
  }

  return { kind: "instructions", instructions, outputs: {} };
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  try {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

    if (request.method === "POST" && request.url === "/jupiter") {
      const key = JSON.stringify({ body, malicious });
      const reused = recent.get(key);

      if (reused && Date.now() - reused.at < ANSWER_LIFETIME_MS) return reply(response, 200, reused.answer);

      const answered = await answer(body);
      recent.set(key, { at: Date.now(), answer: answered });

      return reply(response, 200, answered);
    }
    if (request.method === "POST" && request.url === "/mode") {
      malicious = body.malicious === true;
      return reply(response, 200, { malicious });
    }
    if (request.method === "GET" && request.url === "/mode") return reply(response, 200, { malicious });

    reply(response, 404, { error: `no route ${request.method} ${request.url}` });
  } catch (error) {
    reply(response, error.status ?? 500, { error: error.message });
  }
}).listen(PORT, "127.0.0.1", () => console.error(`jupiter adapter on http://127.0.0.1:${PORT}`));
