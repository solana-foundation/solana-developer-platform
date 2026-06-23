import { unauthorized } from "@/lib/errors";
import { hmacSha256Base64 } from "@/lib/hash";
import { verifyHmacSha256 } from "@/lib/webhook-signature";

export interface PaymentRequestLinkPayload {
  requestId: string;
  recipient: string;
  amount: string;
  mint: string;
  reference: string;
  expiresAt: string | null;
}

const toBase64Url = (base64: string): string =>
  base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const fromBase64Url = (value: string): string => value.replace(/-/g, "+").replace(/_/g, "/");

export async function signPaymentRequestLink(
  payload: PaymentRequestLinkPayload,
  secret: string
): Promise<string> {
  const body = toBase64Url(Buffer.from(JSON.stringify(payload)).toString("base64"));
  const signature = toBase64Url(await hmacSha256Base64(body, secret));
  return `${body}.${signature}`;
}

export async function verifyPaymentRequestLink(
  token: string,
  secret: string
): Promise<PaymentRequestLinkPayload> {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    throw unauthorized("Malformed payment request link");
  }

  const valid = await verifyHmacSha256(
    secret,
    body,
    Buffer.from(fromBase64Url(signature), "base64")
  );
  if (!valid) {
    throw unauthorized("Invalid payment request link signature");
  }

  const payload = JSON.parse(
    Buffer.from(fromBase64Url(body), "base64").toString()
  ) as PaymentRequestLinkPayload;
  if (payload.expiresAt !== null && Date.parse(payload.expiresAt) <= Date.now()) {
    throw unauthorized("Payment request link has expired");
  }
  return payload;
}
