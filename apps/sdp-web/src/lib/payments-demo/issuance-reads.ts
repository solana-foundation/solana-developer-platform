import { listTemplates } from "@sdp/issuance/templates";
import {
  ASSET_CATEGORIES,
  ASSET_TYPES,
  type PublicToken,
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
} from "@sdp/types";
import type { DemoAnswer } from "./demo-handlers";
import {
  type DemoIssuedToken,
  findIssuedToken,
  type IssuanceWorld,
  metadataAuthorityOf,
} from "./issuance-fixtures";

/*
 * What the demo answers for the Issuance reads: tokens and their facets, one token with the
 * authorities it asks for, its transactions, activity, control list and frozen accounts, the
 * templates, and asset profiles. The envelopes, defaults and filters are the SDP API's, so the
 * screens can't tell the two apart.
 */

const REQUEST_ID = "demo_request";

function success(data: unknown, status = 200): DemoAnswer {
  return {
    status,
    body: { data, meta: { requestId: REQUEST_ID, timestamp: new Date().toISOString() } },
  };
}

function notFound(resource: string): DemoAnswer {
  return { status: 404, body: { error: { code: "NOT_FOUND", message: `${resource} not found` } } };
}

function badQuery(message: string, details?: Record<string, unknown>): DemoAnswer {
  return {
    status: 400,
    body: { error: { code: "BAD_REQUEST", message, ...(details ? { details } : {}) } },
  };
}

function whole(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

/** One page of rows in the API's paginated envelope. */
function paginated<T>(
  rows: readonly T[],
  params: URLSearchParams,
  defaults: { pageSize: number; maxPageSize: number }
): DemoAnswer {
  const page = whole(params.get("page"), 1);
  const pageSize = Math.min(whole(params.get("pageSize"), defaults.pageSize), defaults.maxPageSize);
  return {
    status: 200,
    body: {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      meta: {
        total: rows.length,
        page,
        pageSize,
        hasMore: page * pageSize < rows.length,
        requestId: REQUEST_ID,
      },
    },
  };
}

function isDeployed(token: PublicToken): boolean {
  return token.mintAddress !== null || token.deployedAt !== null;
}

function deploymentStatusOf(token: PublicToken): "draft" | "active" | "paused" {
  if (!isDeployed(token)) return "draft";
  return token.status === "paused" ? "paused" : "active";
}

/** `GET /tokens`: search, status, deployment status, template, created range, then sort. */
function tokenList(world: IssuanceWorld, params: URLSearchParams): DemoAnswer {
  const search = params.get("search")?.trim().toLowerCase() ?? "";
  const status = params.get("status");
  const deploymentStatus = params.get("deploymentStatus");
  const template = params.get("template");
  const after = params.get("createdAfter");
  const before = params.get("createdBefore");
  if (after && before && Date.parse(after) > Date.parse(before)) {
    return badQuery("Invalid query parameters", {
      errors: { createdBefore: ["createdBefore must be at or after createdAfter"] },
    });
  }
  const rows = world.tokens
    .map((entry) => entry.token)
    .filter((token) =>
      search
        ? [token.name, token.symbol, token.mintAddress, token.id].some((value) =>
            value?.toLowerCase().includes(search)
          )
        : true
    )
    .filter((token) => (status ? token.status === status : true))
    .filter((token) => (deploymentStatus ? deploymentStatusOf(token) === deploymentStatus : true))
    .filter((token) => (template ? token.template === template : true))
    .filter((token) => (after ? Date.parse(token.createdAt) >= Date.parse(after) : true))
    .filter((token) => (before ? Date.parse(token.createdAt) <= Date.parse(before) : true));

  const byName = params.get("sortBy") === "name";
  const direction = params.get("sortDirection") === "asc" ? 1 : -1;
  rows.sort((left, right) => {
    const order = byName
      ? left.name.toLowerCase().localeCompare(right.name.toLowerCase())
      : left.createdAt.localeCompare(right.createdAt);
    return (order || left.id.localeCompare(right.id)) * direction;
  });
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/facets`: the project's unfiltered totals. */
function tokenFacets(world: IssuanceWorld): DemoAnswer {
  const templates = new Map<string, number>();
  const deploymentStatuses = { draft: 0, active: 0, paused: 0 };
  for (const { token } of world.tokens) {
    templates.set(token.template, (templates.get(token.template) ?? 0) + 1);
    deploymentStatuses[deploymentStatusOf(token)] += 1;
  }
  return success({
    templates: [...templates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([template, count]) => ({ template, count })),
    deploymentStatuses,
    total: world.tokens.length,
  });
}

const INCLUDE_FLAGS = [
  "includeAllowlistAuthority",
  "includeFreezeAuthority",
  "includeMetadataAuthority",
  "includePauseAuthority",
] as const;

/** `GET /tokens/:id`: the token, with each authority it was asked for beside it. */
function tokenDetail(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  for (const flag of INCLUDE_FLAGS) {
    const value = params.get(flag);
    if (value !== null && value !== "true" && value !== "false") {
      return badQuery("Invalid query parameters", { errors: { [flag]: ["Invalid input"] } });
    }
  }
  const { token } = entry;
  const asked = (flag: (typeof INCLUDE_FLAGS)[number]) => params.get(flag) === "true";
  return success({
    token,
    ...(asked("includeAllowlistAuthority")
      ? { allowlistAuthority: token.ablListAddress ? token.mintAuthority : null }
      : {}),
    ...(asked("includeFreezeAuthority") ? { freezeAuthority: token.freezeAuthority } : {}),
    ...(asked("includeMetadataAuthority") ? { metadataAuthority: metadataAuthorityOf(token) } : {}),
    ...(asked("includePauseAuthority")
      ? {
          pauseAuthority: token.extensions?.pausable
            ? (token.extensions.pausable.authority ?? token.mintAuthority)
            : null,
        }
      : {}),
  });
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): value is T {
  return value !== null && (allowed as readonly string[]).includes(value);
}

/** `GET /tokens/:id/transactions`: newest first, one type and one status at most. */
function tokenTransactions(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const type = params.get("type");
  const status = params.get("status");
  if (type !== null && !oneOf(type, TOKEN_TRANSACTION_TYPES)) {
    return badQuery("Invalid query parameters");
  }
  if (status !== null && !oneOf(status, TOKEN_TRANSACTION_STATUSES)) {
    return badQuery("Invalid query parameters");
  }
  const rows = entry.transactions.filter(
    (row) => (type ? row.type === type : true) && (status ? row.status === status : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 500 });
}

/** `GET /transactions`: every token's, each with the token it belongs to. */
function allTransactions(world: IssuanceWorld, params: URLSearchParams): DemoAnswer {
  const types = params.getAll("type");
  const status = params.get("status");
  const invalidTypes = types.filter((type) => !oneOf(type, TOKEN_TRANSACTION_TYPES));
  if (invalidTypes.length > 0) {
    return badQuery("Invalid type query parameter", {
      invalidTypes,
      allowedTypes: TOKEN_TRANSACTION_TYPES,
    });
  }
  if (status !== null && !oneOf(status, TOKEN_TRANSACTION_STATUSES)) {
    return badQuery("Invalid status query parameter", {
      allowedStatuses: TOKEN_TRANSACTION_STATUSES,
    });
  }
  const rows = world.tokens
    .flatMap(({ token, transactions }) =>
      transactions.map((transaction) => ({
        token: {
          id: token.id,
          name: token.name,
          symbol: token.symbol,
          mintAddress: token.mintAddress,
        },
        transaction,
      }))
    )
    .filter(
      ({ transaction }) =>
        (types.length === 0 || types.includes(transaction.type)) &&
        (status ? transaction.status === status : true)
    )
    .sort((left, right) => right.transaction.createdAt.localeCompare(left.transaction.createdAt));
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/:id/audit`: the activity feed, filtered by action, outcome and actor. */
function tokenAudit(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const action = params.get("action");
  const status = params.get("status");
  const actorType = params.get("type");
  const rows = entry.audit.filter(
    (event) =>
      (action ? event.action === action : true) &&
      (status ? event.status === status : true) &&
      (actorType ? event.actorType === actorType : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 100 });
}

/** `GET /tokens/:id/allowlist`: the active entries, searched by address or label. */
function controlList(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  const search = params.get("search")?.trim().toLowerCase() ?? "";
  const label = params.get("label");
  const rows = entry.controlList.filter(
    (row) =>
      row.status === "active" &&
      (search
        ? row.address.toLowerCase().includes(search) ||
          (row.label?.toLowerCase().includes(search) ?? false)
        : true) &&
      (label ? row.label === label : true)
  );
  return paginated(rows, params, { pageSize: 50, maxPageSize: 500 });
}

function controlListLabels(entry: DemoIssuedToken): DemoAnswer {
  const active = entry.controlList.filter((row) => row.status === "active");
  const labels = [...new Set(active.flatMap((row) => (row.label ? [row.label] : [])))].sort(
    (left, right) => left.localeCompare(right)
  );
  return success({ labels, total: active.length });
}

/** `GET /tokens/:id/frozen`: accounts still frozen, latest first. */
function frozenAccounts(entry: DemoIssuedToken, params: URLSearchParams): DemoAnswer {
  return paginated(
    entry.frozen.filter((row) => row.unfrozenAt === null),
    params,
    { pageSize: 50, maxPageSize: 100 }
  );
}

function tokenRoute(world: IssuanceWorld, rest: readonly string[], params: URLSearchParams) {
  const [tokenId = "", sub, leaf] = rest;
  const entry = findIssuedToken(world, tokenId);
  if (!entry) return notFound("Token");
  if (sub === undefined) return tokenDetail(entry, params);
  if (leaf === undefined) {
    switch (sub) {
      case "transactions":
        return tokenTransactions(entry, params);
      case "audit":
        return tokenAudit(entry, params);
      case "allowlist":
        return controlList(entry, params);
      case "frozen":
        return frozenAccounts(entry, params);
      default:
        return undefined;
    }
  }
  return sub === "allowlist" && leaf === "labels" ? controlListLabels(entry) : undefined;
}

function assetProfilesRoute(
  world: IssuanceWorld,
  rest: readonly string[],
  params: URLSearchParams
): DemoAnswer | undefined {
  const [first, second] = rest;
  if (first === undefined) {
    const tokenIds = params.get("tokenIds")?.split(",").filter(Boolean) ?? null;
    const category = params.get("category");
    const profiles = world.tokens
      .map((entry) => entry.profile)
      .filter((profile) => (tokenIds ? tokenIds.includes(profile.tokenId) : true))
      .filter((profile) => (category ? profile.assetCategory === category : true));
    const page = whole(params.get("page"), 1);
    const pageSize = Math.min(whole(params.get("pageSize"), 20), 100);
    return success({
      assetProfiles: profiles.slice((page - 1) * pageSize, page * pageSize),
      total: profiles.length,
      page,
      pageSize,
    });
  }
  if (first === "field-options" && second === undefined) {
    return success({
      fields: {
        categories: ASSET_CATEGORIES,
        types: ASSET_TYPES,
      },
    });
  }
  if (first === "by-token" && second !== undefined) {
    const entry = findIssuedToken(world, second);
    return entry ? success({ assetProfile: entry.profile }) : notFound("Asset profile");
  }
  if (second === undefined) {
    const entry = world.tokens.find((candidate) => candidate.profile.id === first);
    return entry ? success({ assetProfile: entry.profile }) : notFound("Asset profile");
  }
  return undefined;
}

/**
 * The demo's answer to an Issuance read, by the path's segments after `issuance`, or undefined
 * when the demo holds none (the caller then says it isn't part of the demo).
 */
export function issuanceRead(
  world: IssuanceWorld,
  rest: readonly string[],
  params: URLSearchParams
): DemoAnswer | undefined {
  const [resource, ...tail] = rest;
  switch (resource) {
    case "templates": {
      const templates = listTemplates();
      if (tail.length === 0) return success({ templates });
      const template = templates.find((candidate) => candidate.id === tail[0]);
      return tail.length === 1
        ? template
          ? success({ template })
          : notFound("Template")
        : undefined;
    }
    case "tokens":
      if (tail.length === 0) return tokenList(world, params);
      if (tail.length === 1 && tail[0] === "facets") return tokenFacets(world);
      return tokenRoute(world, tail, params);
    case "transactions":
      return tail.length === 0 ? allTransactions(world, params) : undefined;
    case "asset-profiles":
      return assetProfilesRoute(world, tail, params);
    default:
      return undefined;
  }
}
