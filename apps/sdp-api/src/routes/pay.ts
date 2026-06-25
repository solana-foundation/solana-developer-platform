import { Hono } from "hono";
import { createPaymentRequestsRepository } from "@/db/repositories/repository-factory";
import { notFound } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { encodeSolanaPayURL } from "@/services/solana";
import type { Env } from "@/types/env";

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

  const solanaPayUrl = payable
    ? encodeSolanaPayURL({
        recipient: assertValidAddress(request.destination_address, "destinationAddress"),
        amount: request.amount,
        splToken: assertValidAddress(request.token, "token"),
        reference: assertValidAddress(request.reference, "reference"),
        memo: request.id,
      })
    : null;

  return c.json({
    amount: request.amount,
    token: request.token,
    recipient: request.destination_address,
    reference: request.reference,
    status,
    expiresAt: request.expires_at,
    solanaPayUrl,
  });
});

export default pay;
