import {
  EARN_BUTTON_ACCENT_COLOR_PATTERN,
  EARN_BUTTON_PUBLIC_TOKEN_LENGTH,
  EARN_BUTTON_PUBLIC_TOKEN_PATTERN,
  EARN_BUTTON_STYLES,
} from "@sdp/types";
import { isoDateTimeSchema, successResponseSchema, z } from "./base";

const earnButtonStyleSchema = z.enum(EARN_BUTTON_STYLES).openapi({
  description: "Customer-facing Earn button treatment.",
  example: "accent",
});

const earnButtonAccentColorSchema = z.string().regex(EARN_BUTTON_ACCENT_COLOR_PATTERN).openapi({
  description: "Six-digit hexadecimal accent color used by the accent treatment.",
  example: "#9945FF",
});

const earnButtonConfigurationSchema = z
  .object({
    id: z.string().min(1).openapi({ example: "earn_button_config_example" }),
    strategyId: z.string().min(1).openapi({ example: "earn_strategy_example" }),
    style: earnButtonStyleSchema,
    accentColor: earnButtonAccentColorSchema,
    publicToken: z
      .string()
      .length(EARN_BUTTON_PUBLIC_TOKEN_LENGTH)
      .regex(EARN_BUTTON_PUBLIC_TOKEN_PATTERN)
      .openapi({
        description: "Stable unguessable token used by the public engineering handoff.",
        example: "AbCdEfGhIjKlMnOpQrStUvWx",
      }),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .openapi({ description: "Saved Earn button configuration for one project." });

const publicEarnButtonConfigurationSchema = z
  .object({
    strategyId: z.string().min(1).openapi({ example: "earn_strategy_example" }),
    strategyName: z.string().nullable().openapi({ example: "USDC Yield Vault" }),
    provider: z.string().nullable().openapi({ example: "kamino" }),
    style: earnButtonStyleSchema,
    accentColor: earnButtonAccentColorSchema,
    strategyAvailable: z.boolean().openapi({
      description:
        "False when the configured strategy is hidden, delisted, or not active. " +
        "Display metadata is withheld and the handoff should render a stale state.",
      example: true,
    }),
  })
  .openapi({
    description:
      "Public integration handoff data. Tenant identifiers and credentials are never included.",
  });

export const earnButtonConfigurationResponse = successResponseSchema(
  z.object({ configuration: earnButtonConfigurationSchema })
);

export const publicEarnButtonConfigurationResponse = successResponseSchema(
  z.object({ configuration: publicEarnButtonConfigurationSchema })
);
