import { createRpcFromTransport, type SolanaRpc } from "@sdp/rpc/solana";
import { PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS } from "@sdp/spc-escrow";
import { privateChannelTokens } from "@sdp/types/private-channels";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import type { RpcTransport } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { z } from "zod";
import type { JsonRpcResult } from "@/test/helpers/cluster-rpc";
import {
  CLOCK_RPC_ACCOUNT,
  encodedRpcAccount,
  mintRpcAccount,
} from "@/test/helpers/token-movement";

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.array(z.unknown()),
});

/** An account the escrow program owns: an instance's allowlist entry. */
const ESCROW_OWNED = encodedRpcAccount(PRIVATE_CHANNEL_ESCROW_PROGRAM_ADDRESS, new Uint8Array());

/**
 * A devnet project RPC for Private Channels writes: every registered token's
 * mint (its catalogue program and decimals, no extensions), the Clock, and any
 * other account owned by the escrow program, so each token's allowlist entry
 * enables it.
 *
 * @param mintExtensions - Extensions to give the registered Token-2022 or classic mints.
 */
export function privateChannelWriteRpc(
  mintExtensions: Parameters<typeof mintRpcAccount>[1]["extensions"]
): SolanaRpc {
  const mints = new Map<string, JsonRpcResult>(
    privateChannelTokens("devnet").map((token) => [
      token.mint,
      mintRpcAccount(
        token.tokenProgram === SPL_TOKEN_PROGRAMS["token-2022"] ? "token-2022" : "spl-token",
        { decimals: token.decimals, extensions: mintExtensions }
      ),
    ])
  );
  const answer = (at: string): JsonRpcResult => {
    if (at === SYSVAR_CLOCK_ADDRESS) return CLOCK_RPC_ACCOUNT;
    const mint = mints.get(at);
    // Any other account a write reads is the escrow's, owned by the program.
    return mint === undefined ? ESCROW_OWNED : mint;
  };
  const transport: RpcTransport = async <TResponse>({ payload }: Parameters<RpcTransport>[0]) => {
    const request = requestSchema.parse(payload);
    const [first] = request.params;
    const value =
      request.method === "getMultipleAccounts"
        ? z.array(z.string()).parse(first).map(answer)
        : answer(z.string().parse(first));
    // SAFETY: the transport returns the JSON-RPC response body kit asked for.
    return { jsonrpc: "2.0", id: request.id, result: { context: { slot: 0 }, value } } as TResponse;
  };
  return createRpcFromTransport(transport);
}
