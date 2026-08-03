import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

const TOKEN_POST_ACTIONS = {
  deploy: "deploy",
  mint: "mint",
  burn: "burn",
  seize: "seize",
  "force-burn": "force-burn",
  authority: "authority",
  freeze: "freeze",
  unfreeze: "unfreeze",
  pause: "pause",
  unpause: "unpause",
  "refresh-supply": "supply/refresh",
} as const satisfies Record<string, string>;

type TokenPostAction = keyof typeof TOKEN_POST_ACTIONS;

type RouteContext = {
  params: Promise<{ tokenId: string; action: string }>;
};

/**
 * Narrows a route param to a known token POST action.
 * @param action - The raw `[action]` route segment.
 * @returns Whether `action` is a key of `TOKEN_POST_ACTIONS`.
 */
function isTokenPostAction(action: string): action is TokenPostAction {
  return Object.hasOwn(TOKEN_POST_ACTIONS, action);
}

export async function POST(request: Request, context: RouteContext) {
  const { tokenId, action } = await context.params;
  if (!isTokenPostAction(action)) {
    return NextResponse.json(
      { error: { message: "Token action is not supported" } },
      { status: 404 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: `route.dashboard.issuance.token.${action}`,
    path: `/v1/issuance/tokens/${encodeURIComponent(tokenId)}/${TOKEN_POST_ACTIONS[action]}`,
  });
}
