import { encodeURL } from "@solana/pay";
import { Hono } from "hono";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import { assertValidAddress, getSolanaConfig } from "@/lib/solana";
import type { Env } from "@/types/env";
import { resolveTokenLabel, SOL_MINT } from "./payments/token-accounts";

const REQUEST_LABEL = "Solana Developer Platform";

const pay = new Hono<{ Bindings: Env }>();

pay.get("/:token", async (c) => {
  const request = await createPaymentRequestsRepository(c.env).getPaymentRequestByPublicToken(
    c.req.param("token")
  );
  if (!request) {
    throw notFound("Payment request");
  }

  const expired = request.expires_at !== null && Date.parse(request.expires_at) <= Date.now();
  const status = expired && request.status === "awaiting_payment" ? "expired" : request.status;
  const payable = status === "awaiting_payment";

  let solanaPayUrl: string | null = null;
  if (payable) {
    const recipient = assertValidAddress(request.destination_address, "destinationAddress");
    const reference = assertValidAddress(request.reference, "reference");
    const tokenLabel = resolveTokenLabel(request.token);
    const url = encodeURL({
      recipient,
      reference,
      label: REQUEST_LABEL,
      message: `Pay ${request.amount} ${tokenLabel} to ${REQUEST_LABEL}`,
      ...(request.token === SOL_MINT
        ? {}
        : { splToken: assertValidAddress(request.token, "token") }),
    });
    url.searchParams.set("amount", request.amount);
    solanaPayUrl = url.toString();
  }

  return c.json({
    amount: request.amount,
    token: request.token,
    tokenSymbol: resolveTokenLabel(request.token),
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    network: getSolanaConfig(c.env).network,
    solanaPayUrl,
  });
});

export default pay;
