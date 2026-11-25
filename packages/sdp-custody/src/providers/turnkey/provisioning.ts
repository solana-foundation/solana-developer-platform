import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { ApiKeyStamper } from "@solana/keychain-turnkey";
import {
  normalizeProviderNameFragment,
  parseJsonResponse,
  randomHex,
  readErrorResponseText,
  trimTrailingHyphens,
} from "#/shared/common";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";
import { TURNKEY_BY_CLUSTER } from "./cluster-config";

interface TurnkeyActivityResponse {
  activity?: {
    status?: string;
    result?: {
      createPrivateKeysResultV2?: {
        privateKeys?: Array<{
          privateKeyId?: string;
          addresses?: Array<{
            format?: string;
            address?: string;
          }>;
        }>;
      };
    };
  };
}

export interface ProvisionTurnkeyOptions {
  orgId: string;
  orgSlug: string;
}

export interface TurnkeyProvisioningConfig {
  cluster: SolanaCluster;
  apiPublicKey?: string;
  apiPrivateKey?: string;
  organizationId?: string;
}

export interface ProvisionTurnkeyResult {
  privateKeyId: string;
  address: string;
}

export async function provisionTurnkeyPrivateKey(
  runtime: CustodyProvisioningRuntime,
  config: TurnkeyProvisioningConfig,
  options: ProvisionTurnkeyOptions
): Promise<ProvisionTurnkeyResult> {
  const apiPublicKey = config.apiPublicKey;
  const apiPrivateKey = config.apiPrivateKey;
  const organizationId = config.organizationId;

  if (!apiPublicKey || !apiPrivateKey || !organizationId) {
    throw new SigningError(
      "Turnkey environment variables not configured: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const created = await turnkeyRequest<TurnkeyActivityResponse>(runtime, {
    cluster: config.cluster,
    apiPublicKey,
    apiPrivateKey,
    method: "POST",
    path: "/public/v1/submit/create_private_keys",
    body: {
      type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
      timestampMs: runtime.now().toString(),
      organizationId,
      parameters: {
        privateKeys: [
          {
            privateKeyName: buildTurnkeyPrivateKeyName(options.orgSlug || options.orgId),
            curve: "CURVE_ED25519",
            privateKeyTags: [],
            addressFormats: ["ADDRESS_FORMAT_SOLANA"],
          },
        ],
      },
    },
  });

  const createdKey = created.activity?.result?.createPrivateKeysResultV2?.privateKeys?.[0];

  const privateKeyId = createdKey?.privateKeyId;
  const address = findSolanaAddress(createdKey?.addresses);
  if (!privateKeyId || !address) {
    throw new SigningError("Turnkey private key creation failed", "PROVIDER_NOT_CONFIGURED");
  }

  return { privateKeyId, address };
}

interface TurnkeyRequestParams {
  cluster: SolanaCluster;
  method: "POST";
  path: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  body: Record<string, unknown>;
}

async function turnkeyRequest<T>(
  runtime: CustodyProvisioningRuntime,
  params: TurnkeyRequestParams
): Promise<T> {
  const body = JSON.stringify(params.body);
  const stamper = new ApiKeyStamper({
    apiPrivateKey: params.apiPrivateKey,
    apiPublicKey: params.apiPublicKey,
  });
  // ApiKeyStamper is currently synchronous, but normalize in case the SDK
  // ever changes stamp() to return a Promise.
  const stamp = await Promise.resolve(stamper.stamp(body));

  try {
    const response = await runtime.fetch(
      `${TURNKEY_BY_CLUSTER[params.cluster].origin}${params.path}`,
      {
        method: params.method,
        headers: {
          "Content-Type": "application/json",
          [stamp.stampHeaderName]: stamp.stampHeaderValue,
        },
        body,
      }
    );

    if (!response.ok) {
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Turnkey API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to call Turnkey API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

function buildTurnkeyPrivateKeyName(value: string): string {
  const suffix = randomHex(2);
  let normalized = normalizeProviderNameFragment(value);

  if (!normalized) {
    normalized = "org";
  }

  let name = `sdp-${normalized}-${suffix}`.slice(0, 60);
  name = trimTrailingHyphens(name);

  if (!name) {
    name = `sdp-${randomHex(3)}`;
  }

  return name;
}

function findSolanaAddress(
  addresses:
    | Array<{
        format?: string;
        address?: string;
      }>
    | undefined
): string | undefined {
  if (!addresses?.length) return undefined;

  const solana = addresses.find((entry) => entry.format === "ADDRESS_FORMAT_SOLANA");
  if (solana?.address) {
    return solana.address;
  }

  return addresses.find((entry) => Boolean(entry.address))?.address;
}
