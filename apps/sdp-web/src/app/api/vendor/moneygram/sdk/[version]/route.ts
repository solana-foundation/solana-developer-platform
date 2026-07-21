import { createHash } from "node:crypto";
import { MONEYGRAM_SDK_VERSION } from "@/lib/moneygram-sdk";

const MONEYGRAM_SDK_UPSTREAM_URL = "https://playground.xramps.moneygram.com/sdk/index.global.js";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, s-maxage=31536000, immutable";

let verifiedSdk: ArrayBuffer | null = null;

/** Fetches the upstream SDK once per server instance; the URL is keyed by content hash, so a verified buffer never goes stale. */
async function fetchVerifiedSdk(): Promise<ArrayBuffer> {
  if (verifiedSdk) {
    return verifiedSdk;
  }
  const upstream = await fetch(MONEYGRAM_SDK_UPSTREAM_URL, { cache: "no-store" });
  if (!upstream.ok) {
    throw new Error("MoneyGram SDK is unavailable.");
  }
  const sdk = await upstream.arrayBuffer();
  const digest = createHash("sha256").update(new Uint8Array(sdk)).digest("hex");
  if (digest !== MONEYGRAM_SDK_VERSION) {
    throw new Error("MoneyGram SDK integrity check failed.");
  }
  verifiedSdk = sdk;
  return sdk;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string }> }
): Promise<Response> {
  const { version } = await params;
  if (version !== MONEYGRAM_SDK_VERSION) {
    return new Response("MoneyGram SDK version not found.", { status: 404 });
  }

  let sdk: ArrayBuffer;
  try {
    sdk = await fetchVerifiedSdk();
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "MoneyGram SDK is unavailable.", {
      status: 502,
    });
  }

  return new Response(sdk, {
    headers: {
      "Cache-Control": IMMUTABLE_CACHE_CONTROL,
      "Content-Type": "text/javascript; charset=utf-8",
      ETag: `"${MONEYGRAM_SDK_VERSION}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
