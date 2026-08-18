import type { Context } from "hono";
import {
  createPrivateChannelDepositRepository,
  createPrivateChannelEventRepository,
  createPrivateChannelInstanceRepository,
  createPrivateChannelReferenceRepository,
  createPrivateChannelRepository,
  createPrivateChannelTransferRepository,
  createPrivateChannelUserRepository,
  createPrivateChannelVerifiedWalletRepository,
  createPrivateChannelWithdrawalRepository,
  createProjectUserRepository,
} from "@/db/repositories";
import { createPrivateChannelEventService } from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";

/** Hono request context bound to the app `Env`. */
export type AppContext = Context<{ Bindings: Env }>;

export function getPrivateChannelInstanceRepository(c: AppContext) {
  return createPrivateChannelInstanceRepository(c.env);
}

export function getPrivateChannelRepository(c: AppContext) {
  return createPrivateChannelRepository(c.env);
}

export function getPrivateChannelDepositRepository(c: AppContext) {
  return createPrivateChannelDepositRepository(c.env);
}

export function getPrivateChannelWithdrawalRepository(c: AppContext) {
  return createPrivateChannelWithdrawalRepository(c.env);
}

export function getPrivateChannelTransferRepository(c: AppContext) {
  return createPrivateChannelTransferRepository(c.env);
}

export function getPrivateChannelVerifiedWalletRepository(c: AppContext) {
  return createPrivateChannelVerifiedWalletRepository(c.env);
}

export function getPrivateChannelEventRepository(c: AppContext) {
  return createPrivateChannelEventRepository(c.env);
}

export function getPrivateChannelReferenceRepository(c: AppContext) {
  return createPrivateChannelReferenceRepository(c.env);
}

export function getPrivateChannelEventService(c: AppContext) {
  return createPrivateChannelEventService(c.env);
}

export function getPrivateChannelUserRepository(c: AppContext) {
  return createPrivateChannelUserRepository(c.env);
}

export function getProjectUserRepository(c: AppContext) {
  return createProjectUserRepository(c.env);
}
