import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type {
  SponsorshipBudgetPolicy,
  SponsorshipBudgetUsage,
  SponsorshipLiveWindowReservation,
  SponsorshipNetwork,
} from "@/db/repositories/sponsorship-budget.repository";
import type { Env } from "@/types/env";
import { getRedisClient } from "./kv-redis";

const INITIALIZE_LUA = `
local count = tonumber(ARGV[1])
local seeded_hour = {}
local seeded_day = {}
for i = 1, count do
  local field = ARGV[1 + i]
  local marker = '__initialized:' .. field
  if not redis.call('HGET', KEYS[1], marker) then
    redis.call('HSET', KEYS[1], field, ARGV[1 + count + i])
    redis.call('HSET', KEYS[1], marker, '1')
    seeded_hour[field] = true
  end
  if not redis.call('HGET', KEYS[2], marker) then
    redis.call('HSET', KEYS[2], field, ARGV[1 + count * 2 + i])
    redis.call('HSET', KEYS[2], marker, '1')
    seeded_day[field] = true
  end
end
redis.call('PEXPIRE', KEYS[1], ARGV[2 + count * 3])
redis.call('PEXPIRE', KEYS[2], ARGV[3 + count * 3])
local cursor = 3 + count * 3
local function reconstruct(hash_key, seeded)
  local reservations = tonumber(ARGV[cursor + 1])
  cursor = cursor + 1
  for i = 1, reservations do
    local ownership = ARGV[cursor + 1]
    local reserved = tonumber(ARGV[cursor + 2])
    local settlement_key = ARGV[cursor + 3]
    local field_count = tonumber(ARGV[cursor + 4])
    cursor = cursor + 4
    local fields = {}
    for f = 1, field_count do
      fields[f] = ARGV[cursor + f]
    end
    cursor = cursor + field_count
    local settled = redis.call('GET', settlement_key)
    for f = 1, field_count do
      local field = fields[f]
      if seeded[field] then
        if settled then
          local delta = tonumber(settled) - reserved
          if delta ~= 0 then redis.call('HINCRBY', hash_key, field, delta) end
        else
          redis.call('HSET', hash_key, ownership .. ':' .. field, reserved)
          redis.call('HSET', hash_key, ownership, reserved)
        end
      end
    end
  end
end
reconstruct(KEYS[1], seeded_hour)
reconstruct(KEYS[2], seeded_day)
return 1
`;

const RESERVE_LUA = `
local existing = redis.call('GET', KEYS[3])
local amount = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
for i = 1, count do
  local offset = 2 + ((i - 1) * 6)
  local field = ARGV[offset + 1]
  local per_tx = tonumber(ARGV[offset + 2])
  local hour_limit = tonumber(ARGV[offset + 3])
  local day_limit = tonumber(ARGV[offset + 4])
  local control_field = ARGV[offset + 5]
  local expected_version = ARGV[offset + 6]
  local marker = '__initialized:' .. field
  if not redis.call('HGET', KEYS[1], marker) or not redis.call('HGET', KEYS[2], marker) then
    return {-2, i}
  end
  local control = redis.call('HGET', KEYS[4], control_field)
  if not control or control ~= expected_version .. ':1' then return {-3, i} end
end
if existing or redis.call('GET', KEYS[5]) then return {2, tonumber(existing or '0')} end
local ownership_field = ARGV[4 + count * 6]
local counted_hour = {}
local counted_day = {}
for i = 1, count do
  local offset = 2 + ((i - 1) * 6)
  local field = ARGV[offset + 1]
  local per_tx = tonumber(ARGV[offset + 2])
  local hour_limit = tonumber(ARGV[offset + 3])
  local day_limit = tonumber(ARGV[offset + 4])
  if amount > per_tx then return {0, i} end
  counted_hour[i] = redis.call('HGET', KEYS[1], ownership_field .. ':' .. field)
  counted_day[i] = redis.call('HGET', KEYS[2], ownership_field .. ':' .. field)
  local hour_used = tonumber(redis.call('HGET', KEYS[1], field) or '0')
  if counted_hour[i] then
    if hour_used > hour_limit then return {0, i} end
  elseif hour_used + amount > hour_limit then
    return {0, i}
  end
  local day_used = tonumber(redis.call('HGET', KEYS[2], field) or '0')
  if counted_day[i] then
    if day_used > day_limit then return {0, i} end
  elseif day_used + amount > day_limit then
    return {0, i}
  end
end
for i = 1, count do
  local field = ARGV[2 + ((i - 1) * 6) + 1]
  if not counted_hour[i] then
    redis.call('HINCRBY', KEYS[1], field, amount)
    redis.call('HSET', KEYS[1], ownership_field .. ':' .. field, amount)
  end
  if not counted_day[i] then
    redis.call('HINCRBY', KEYS[2], field, amount)
    redis.call('HSET', KEYS[2], ownership_field .. ':' .. field, amount)
  end
end
redis.call('HSET', KEYS[1], ownership_field, amount)
redis.call('HSET', KEYS[2], ownership_field, amount)
redis.call('SET', KEYS[3], amount, 'PX', ARGV[3 + count * 6])
return {1, amount}
`;

const SYNC_CONTROL_LUA = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local separator = string.find(current, ':')
  local current_version = tonumber(string.sub(current, 1, separator - 1))
  if current_version > tonumber(ARGV[2]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. ':' .. ARGV[3])
return 1
`;

const CANCEL_LUA = `
local owned_value = redis.call('GET', KEYS[3])
local hour_owned = redis.call('HGET', KEYS[1], ARGV[1])
local day_owned = redis.call('HGET', KEYS[2], ARGV[1])
local amount_value = owned_value or hour_owned or day_owned
if not amount_value then return 0 end
local amount = tonumber(amount_value)
if hour_owned and tonumber(hour_owned) ~= amount then return -2 end
if day_owned and tonumber(day_owned) ~= amount then return -2 end
local function covers(hash_key, field)
  if redis.call('HGET', hash_key, ARGV[1] .. ':' .. field) then return true end
  if not redis.call('HGET', hash_key, ARGV[1]) then return false end
  for i = 2, #ARGV do
    if redis.call('HGET', hash_key, ARGV[1] .. ':' .. ARGV[i]) then return false end
  end
  return redis.call('HGET', hash_key, '__initialized:' .. field) ~= false
end
for i = 2, #ARGV do
  local field = ARGV[i]
  for key_index = 1, 2 do
    if covers(KEYS[key_index], field) then
      local used = tonumber(redis.call('HGET', KEYS[key_index], field) or '0')
      if used < amount then return -1 end
    end
  end
end
for key_index = 1, 2 do
  local adjusted = {}
  for i = 2, #ARGV do
    adjusted[i] = covers(KEYS[key_index], ARGV[i])
  end
  for i = 2, #ARGV do
    if adjusted[i] then
      redis.call('HINCRBY', KEYS[key_index], ARGV[i], -amount)
      redis.call('HDEL', KEYS[key_index], ARGV[1] .. ':' .. ARGV[i])
    end
  end
end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return amount
`;

const SETTLE_LUA = `
if redis.call('GET', KEYS[4]) then return {1, 0} end
local reserved = tonumber(ARGV[1])
local actual = tonumber(ARGV[2])
local count = tonumber(ARGV[3])
local delta = actual - reserved
local owned_value = redis.call('GET', KEYS[3])
if not owned_value and ARGV[5 + count] ~= '1' then return {0, 2} end
if owned_value and tonumber(owned_value) ~= reserved then return {0, 2} end
local ownership_field = ARGV[6 + count]
local function covers(hash_key, field)
  if redis.call('HGET', hash_key, ownership_field .. ':' .. field) then return true end
  if not redis.call('HGET', hash_key, ownership_field) then return false end
  for i = 4, 3 + count do
    if redis.call('HGET', hash_key, ownership_field .. ':' .. ARGV[i]) then return false end
  end
  return redis.call('HGET', hash_key, '__initialized:' .. field) ~= false
end
for key_index = 1, 2 do
  local hash_owned = redis.call('HGET', KEYS[key_index], ownership_field)
  if hash_owned and tonumber(hash_owned) ~= reserved then return {0, 2} end
  if delta < 0 then
    for i = 4, 3 + count do
      if covers(KEYS[key_index], ARGV[i]) then
        local current = tonumber(redis.call('HGET', KEYS[key_index], ARGV[i]) or '0')
        if current < -delta then return {0, 1} end
      end
    end
  end
end
for key_index = 1, 2 do
  local adjusted = {}
  for i = 4, 3 + count do
    adjusted[i] = covers(KEYS[key_index], ARGV[i])
  end
  for i = 4, 3 + count do
    if adjusted[i] then
      if delta ~= 0 then redis.call('HINCRBY', KEYS[key_index], ARGV[i], delta) end
      redis.call('HDEL', KEYS[key_index], ownership_field .. ':' .. ARGV[i])
    end
  end
  redis.call('HDEL', KEYS[key_index], ownership_field)
end
redis.call('DEL', KEYS[3])
redis.call('SET', KEYS[4], actual, 'PX', ARGV[4 + count])
return {1, delta}
`;

const SCRIPT_SHA = {
  initialize: createHash("sha1").update(INITIALIZE_LUA).digest("hex"),
  reserve: createHash("sha1").update(RESERVE_LUA).digest("hex"),
  cancel: createHash("sha1").update(CANCEL_LUA).digest("hex"),
  syncControl: createHash("sha1").update(SYNC_CONTROL_LUA).digest("hex"),
  settle: createHash("sha1").update(SETTLE_LUA).digest("hex"),
};

export interface BudgetAdmissionInput {
  network: SponsorshipNetwork;
  organizationId: string;
  projectId: string | null;
  hourBucket: string;
  dayBucket: string;
  reservationId: string;
  attempt: number;
  amount: number;
  policies: SponsorshipBudgetPolicy[];
  usage: { hour: SponsorshipBudgetUsage; day: SponsorshipBudgetUsage };
  liveReservations?: {
    hour: SponsorshipLiveWindowReservation[];
    day: SponsorshipLiveWindowReservation[];
  };
}

export class SponsorshipBudgetRedis {
  private client: Promise<Redis> | null = null;

  constructor(private readonly env: Pick<Env, "REDIS_URL">) {}

  async reserve(
    input: BudgetAdmissionInput
  ): Promise<"admitted" | "duplicate" | "denied" | "stale_policy"> {
    const client = await this.getClient();
    const keys = this.keys(input);
    const fields = this.fields(input.organizationId, input.projectId);
    const hourUsage = [input.usage.hour.global, input.usage.hour.organization];
    const dayUsage = [input.usage.day.global, input.usage.day.organization];
    if (input.projectId) {
      hourUsage.push(input.usage.hour.project);
      dayUsage.push(input.usage.day.project);
    }
    const liveReservations = input.liveReservations ?? { hour: [], day: [] };
    const prefix = `sdp:sponsorship:{${input.network}}`;
    const reservationMarkerArgs = (reservations: SponsorshipLiveWindowReservation[]) =>
      reservations.flatMap((reservation) => {
        const scopeFields = this.fields(reservation.organizationId, reservation.projectId);
        return [
          this.ownershipField({ reservationId: reservation.id, attempt: reservation.attempt }),
          reservation.reservedLamports,
          `${prefix}:settlement:${reservation.id}:${reservation.attempt}`,
          scopeFields.length,
          ...scopeFields,
        ];
      });
    await this.runScript(
      client,
      "initialize",
      INITIALIZE_LUA,
      [keys.hour, keys.day],
      [
        fields.length,
        ...fields,
        ...hourUsage,
        ...dayUsage,
        this.ttlUntilNextHour(),
        this.ttlUntilNextDay(),
        liveReservations.hour.length,
        ...reservationMarkerArgs(liveReservations.hour),
        liveReservations.day.length,
        ...reservationMarkerArgs(liveReservations.day),
      ]
    );
    const policyByScope = new Map(input.policies.map((policy) => [policy.scopeType, policy]));
    await Promise.all(input.policies.map((policy) => this.syncPolicy(policy)));
    const args: Array<string | number> = [input.amount, fields.length];
    for (let index = 0; index < fields.length; index += 1) {
      const scopeType = index === 0 ? "global" : index === 1 ? "organization" : "project";
      const policy = policyByScope.get(scopeType);
      if (!policy) throw new Error(`Missing ${scopeType} sponsorship budget policy`);
      args.push(
        fields[index],
        policy.perTransactionLamports,
        policy.hourlyLamports,
        policy.dailyLamports,
        this.controlField(policy),
        policy.version
      );
    }
    args.push(this.ttlUntilNextDay(), this.ownershipField(input));
    const result = (await this.runScript(
      client,
      "reserve",
      RESERVE_LUA,
      [keys.hour, keys.day, keys.reservation, keys.control, keys.settlement],
      args
    )) as [number, number];
    if (result[0] === 2) return "duplicate";
    if (result[0] === 1) return "admitted";
    if (result[0] === -3) return "stale_policy";
    return "denied";
  }

  async cancel(input: Omit<BudgetAdmissionInput, "amount" | "policies" | "usage">): Promise<void> {
    const client = await this.getClient();
    const keys = this.keys(input);
    const result = await this.runScript(
      client,
      "cancel",
      CANCEL_LUA,
      [keys.hour, keys.day, keys.reservation],
      [this.ownershipField(input), ...this.fields(input.organizationId, input.projectId)]
    );
    if (Number(result) === -1 || Number(result) === -2) {
      throw new Error("Sponsorship budget counter invariant violated during compensation");
    }
  }

  async syncPolicy(policy: SponsorshipBudgetPolicy): Promise<void> {
    const client = await this.getClient();
    const controlKey = `sdp:sponsorship:{${policy.network}}:control`;
    await this.runScript(
      client,
      "syncControl",
      SYNC_CONTROL_LUA,
      [controlKey],
      [this.controlField(policy), policy.version, policy.enabled ? 1 : 0]
    );
  }

  async getPolicyControl(
    policy: SponsorshipBudgetPolicy
  ): Promise<{ version: number; enabled: boolean } | null> {
    const client = await this.getClient();
    const value = await client.hget(
      `sdp:sponsorship:{${policy.network}}:control`,
      this.controlField(policy)
    );
    if (!value) return null;
    const [version, enabled] = value.split(":");
    const parsedVersion = Number(version);
    if (!Number.isSafeInteger(parsedVersion) || (enabled !== "0" && enabled !== "1")) {
      throw new Error(`Malformed Redis sponsorship control for ${policy.id}`);
    }
    return { version: parsedVersion, enabled: enabled === "1" };
  }

  async settle(input: {
    network: SponsorshipNetwork;
    organizationId: string;
    projectId: string | null;
    hourBucket: string;
    dayBucket: string;
    reservationId: string;
    attempt: number;
    reservedLamports: number;
    actualLamports: number;
    /** Set only when this attempt is durably terminal in Postgres. */
    detectMissingReservation?: boolean;
  }): Promise<number> {
    const client = await this.getClient();
    const keys = this.keys(input);
    const result = (await this.runScript(
      client,
      "settle",
      SETTLE_LUA,
      [keys.hour, keys.day, keys.reservation, keys.settlement],
      [
        input.reservedLamports,
        input.actualLamports,
        this.fields(input.organizationId, input.projectId).length,
        ...this.fields(input.organizationId, input.projectId),
        this.ttlUntilNextDay(),
        input.detectMissingReservation ? 1 : 0,
        this.ownershipField(input),
      ]
    )) as [number, number];
    if (Number(result[0]) !== 1) {
      throw new Error("Sponsorship budget counter invariant violated during settlement");
    }
    return Number(result[1]);
  }

  private fields(organizationId: string, projectId: string | null): string[] {
    const fields = ["global", `organization:${organizationId}`];
    if (projectId) fields.push(`project:${projectId}`);
    return fields;
  }

  private getClient(): Promise<Redis> {
    this.client ??= getRedisClient(this.env);
    return this.client;
  }

  private keys(input: {
    network: SponsorshipNetwork;
    hourBucket: string;
    dayBucket: string;
    reservationId: string;
    attempt: number;
  }) {
    const prefix = `sdp:sponsorship:{${input.network}}`;
    return {
      hour: `${prefix}:hour:${input.hourBucket}`,
      day: `${prefix}:day:${input.dayBucket}`,
      reservation: `${prefix}:reservation:${input.reservationId}:${input.attempt}`,
      settlement: `${prefix}:settlement:${input.reservationId}:${input.attempt}`,
      control: `${prefix}:control`,
    };
  }

  private ownershipField(input: { reservationId: string; attempt: number }): string {
    return `__reservation:${input.reservationId}:${input.attempt}`;
  }

  private controlField(policy: SponsorshipBudgetPolicy): string {
    return `${policy.scopeType}:${policy.scopeId ?? "default"}`;
  }

  private ttlUntilNextHour(): number {
    const now = Date.now();
    return Math.max(60_000, Math.ceil(3_600_000 - (now % 3_600_000) + 3_600_000));
  }

  private ttlUntilNextDay(): number {
    const now = Date.now();
    return Math.max(60_000, Math.ceil(86_400_000 - (now % 86_400_000) + 86_400_000));
  }

  private async runScript(
    client: Redis,
    name: keyof typeof SCRIPT_SHA,
    source: string,
    keys: string[],
    args: Array<string | number>
  ): Promise<unknown> {
    try {
      return await client.evalsha(SCRIPT_SHA[name], keys.length, ...keys, ...args);
    } catch (error) {
      if (error instanceof Error && error.message.includes("NOSCRIPT")) {
        return client.eval(source, keys.length, ...keys, ...args);
      }
      throw error;
    }
  }
}
