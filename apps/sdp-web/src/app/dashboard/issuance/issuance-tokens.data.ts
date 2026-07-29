import type { AssetCategory, IssuanceMetadata } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { type IssuanceListQuery, toIssuanceTokensApiParams } from "./issuance-list-query";
import type { IssuanceTokenView } from "./issuance-token-fields";

// Server-side fetchers for the asset list. Shared by the RSC page (first paint,
// so a shared/bookmarked filtered URL renders server-side) and the BFF route the
// workspace calls for every later search/filter/sort/page — one implementation,
// so the two paths can't diverge.

/**
 * The list's row model. Aliased to the view type the list/grid components render
 * — one shape, so a field can't be dropped in transit. Type-only import, so no
 * component code is pulled into the server/route bundle.
 */
export type IssuanceTokenListItem = IssuanceTokenView;
export type IssuanceAssetProfileView = NonNullable<IssuanceTokenView["assetProfile"]>;

export interface IssuanceTokensPage {
  tokens: IssuanceTokenListItem[];
  /** Rows matching the active filters — what pagination counts against. */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** HTTP status of the token request, for telling a client error from a server one. */
  status: number | null;
  error: string | null;
}

export interface IssuanceTokenFacets {
  templates: Array<{ template: string; count: number }>;
  deploymentStatuses: { draft: number; active: number; paused: number };
  /** Unfiltered project total — separates "no assets yet" from "no matches". */
  total: number;
}

export const EMPTY_ISSUANCE_TOKEN_FACETS: IssuanceTokenFacets = {
  templates: [],
  deploymentStatuses: { draft: 0, active: 0, paused: 0 },
  total: 0,
};

interface RawToken {
  id?: string;
  name?: string;
  symbol?: string;
  status?: string;
  template?: string;
  imageUrl?: string | null;
  mintAddress?: string | null;
  totalSupply?: string;
  createdAt?: string;
  deployedAt?: string | null;
  decimals?: number;
  maxSupply?: string | null;
  isMintable?: boolean;
  isFreezable?: boolean;
  requiresAllowlist?: boolean;
  description?: string | null;
  uri?: string | null;
  signingWalletId?: string | null;
  mintAuthority?: string | null;
  metadataAuthority?: string | null;
  freezeAuthority?: string | null;
  extensions?: { permanentDelegate?: string | null } | null;
}

function parseErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return (parsed?.error?.message ?? parsed?.message ?? body) || fallback;
  } catch {
    return body || fallback;
  }
}

function mapToken(token: RawToken, fallbackName: string): IssuanceTokenListItem {
  return {
    id: token.id ?? "",
    name: token.name ?? fallbackName,
    symbol: token.symbol ?? "-",
    status: token.status ?? "pending",
    template: token.template ?? "custom",
    imageUrl: token.imageUrl ?? null,
    mintAddress: token.mintAddress ?? null,
    totalSupply: token.totalSupply ?? "0",
    createdAt: token.createdAt ?? "",
    deployedAt: token.deployedAt ?? null,
    decimals: typeof token.decimals === "number" ? token.decimals : 0,
    maxSupply: token.maxSupply ?? null,
    isMintable: token.isMintable ?? false,
    isFreezable: token.isFreezable ?? false,
    requiresAllowlist: token.requiresAllowlist ?? false,
    description: token.description ?? null,
    uri: token.uri ?? null,
    signingWalletId: token.signingWalletId ?? null,
    mintAuthority: token.mintAuthority ?? null,
    metadataAuthority: token.metadataAuthority ?? null,
    freezeAuthority: token.freezeAuthority ?? null,
    permanentDelegate: token.extensions?.permanentDelegate ?? null,
    assetProfile: null,
  };
}

/**
 * One page of tokens for the given list state. Search, filtering, sorting and
 * paging all happen in the API — this only maps the response.
 */
export async function fetchIssuanceTokensPage(
  request: SdpApiClient["request"],
  query: IssuanceListQuery,
  options: { untitledLabel?: string; nowMs?: number } = {}
): Promise<IssuanceTokensPage> {
  const untitledLabel = options.untitledLabel ?? "Untitled token";
  const empty = {
    tokens: [] as IssuanceTokenListItem[],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    hasMore: false,
  };

  try {
    const params = toIssuanceTokensApiParams(query, options.nowMs ?? Date.now());
    const response = await request(`/v1/issuance/tokens?${params.toString()}`);

    if (!response.ok) {
      const body = await response.text();
      return {
        ...empty,
        status: response.status,
        error: parseErrorMessage(body, `Token list request failed (${response.status}).`),
      };
    }

    const json = (await response.json()) as {
      data?: RawToken[];
      meta?: { total?: number; page?: number; pageSize?: number; hasMore?: boolean };
    };

    const tokens = (json?.data ?? [])
      .filter((token): token is RawToken => Boolean(token?.id))
      .map((token) => mapToken(token, untitledLabel));

    return {
      tokens,
      total: json.meta?.total ?? tokens.length,
      page: json.meta?.page ?? query.page,
      pageSize: json.meta?.pageSize ?? query.pageSize,
      hasMore: json.meta?.hasMore ?? false,
      status: response.status,
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      status: null,
      error: error instanceof Error ? error.message : "Token list request failed.",
    };
  }
}

/**
 * Filter facets (template ids in use, lifecycle counts, unfiltered total).
 * Soft-fails to zeroed facets: the list still renders, it just offers no
 * template options.
 */
export async function fetchIssuanceTokenFacets(
  request: SdpApiClient["request"]
): Promise<IssuanceTokenFacets> {
  try {
    const response = await request("/v1/issuance/tokens/facets");
    if (!response.ok) {
      return EMPTY_ISSUANCE_TOKEN_FACETS;
    }

    const json = (await response.json()) as { data?: Partial<IssuanceTokenFacets> };
    const facets = json?.data;
    if (!facets) {
      return EMPTY_ISSUANCE_TOKEN_FACETS;
    }

    return {
      templates: (facets.templates ?? []).filter(
        (entry): entry is { template: string; count: number } => typeof entry?.template === "string"
      ),
      deploymentStatuses: {
        draft: facets.deploymentStatuses?.draft ?? 0,
        active: facets.deploymentStatuses?.active ?? 0,
        paused: facets.deploymentStatuses?.paused ?? 0,
      },
      total: facets.total ?? 0,
    };
  } catch {
    return EMPTY_ISSUANCE_TOKEN_FACETS;
  }
}

/**
 * Attaches asset profiles to a page of tokens, hydrating exactly the ids on that
 * page rather than paging the project's whole profile list.
 *
 * Best-effort by design: soft-fails to the tokens unchanged (the asset-profiles
 * feature flag being off answers 403), so the list never blocks on it and simply
 * falls back to core fields.
 */
export async function attachIssuanceAssetProfiles(
  request: SdpApiClient["request"],
  tokens: IssuanceTokenListItem[]
): Promise<IssuanceTokenListItem[]> {
  if (tokens.length === 0) {
    return tokens;
  }

  try {
    const params = new URLSearchParams({
      page: "1",
      // One profile per token at most, so the page can never be short.
      pageSize: String(tokens.length),
      tokenIds: tokens.map((token) => token.id).join(","),
    });
    const response = await request(`/v1/issuance/asset-profiles?${params.toString()}`);
    if (!response.ok) {
      return tokens;
    }

    const json = (await response.json()) as {
      data?: {
        assetProfiles?: Array<{
          tokenId?: string;
          assetCategory?: AssetCategory;
          assetType?: string;
          assetTypeVersion?: number;
          issuanceMetadata?: IssuanceMetadata;
        }>;
      };
    };

    const byTokenId = new Map<string, IssuanceAssetProfileView>();
    for (const profile of json?.data?.assetProfiles ?? []) {
      if (!profile?.tokenId || !profile.assetCategory || !profile.assetType) {
        continue;
      }
      byTokenId.set(profile.tokenId, {
        assetCategory: profile.assetCategory,
        assetType: profile.assetType,
        assetTypeVersion: profile.assetTypeVersion ?? 1,
        issuanceMetadata: profile.issuanceMetadata ?? {},
      });
    }

    if (byTokenId.size === 0) {
      return tokens;
    }

    return tokens.map((token) => ({
      ...token,
      assetProfile: byTokenId.get(token.id) ?? null,
    }));
  } catch {
    return tokens;
  }
}
