/**
 * Token Templates Handler
 *
 * Provides endpoints for listing available token templates and their configuration.
 */

import type { ListTemplatesResponse, TokenTemplateResponse } from "@sdp/types";
import type { Context } from "hono";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPublicTemplateInfo, listTemplates } from "@/services/issuance/templates";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * GET /v1/issuance/templates
 * List all available token templates
 */
export const listTokenTemplates = async (c: AppContext) => {
  const templates = listTemplates();

  const response: ListTemplatesResponse = { templates };
  return success(c, response);
};

/**
 * GET /v1/issuance/templates/:templateId
 * Get a specific template by ID
 */
export const getTokenTemplate = async (c: AppContext) => {
  const { templateId } = c.req.param();

  const template = getPublicTemplateInfo(templateId);

  if (!template) {
    throw notFound("Template");
  }

  const response: TokenTemplateResponse = { template };
  return success(c, response);
};
