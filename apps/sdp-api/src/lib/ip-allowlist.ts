type IpVersion = 4 | 6;

interface ParsedIp {
  version: IpVersion;
  bytes: number[];
}

interface ParsedIpRange extends ParsedIp {
  prefixLength: number;
}

export function isValidIpAllowlistEntry(value: string): boolean {
  return parseIpRange(value) !== null;
}

export function ipMatchesAllowedIps(ip: string | null, allowedIps: unknown): boolean {
  if (allowedIps == null) {
    return true;
  }

  if (!Array.isArray(allowedIps)) {
    return false;
  }

  if (allowedIps.length === 0) {
    return true;
  }

  const parsedIp = ip ? normalizeIpv4MappedIp(parseIp(ip)) : null;
  if (!parsedIp) {
    return false;
  }

  const ranges: ParsedIpRange[] = [];
  for (const entry of allowedIps) {
    if (typeof entry !== "string") {
      return false;
    }

    const range = parseIpRange(entry);
    if (!range) {
      return false;
    }

    ranges.push(range);
  }

  for (const range of ranges) {
    if (range.version === parsedIp.version && matchesPrefix(parsedIp.bytes, range)) {
      return true;
    }
  }

  return false;
}

function parseIpRange(value: string): ParsedIpRange | null {
  const [rawIp, rawPrefix, extra] = value.trim().split("/");
  if (!rawIp || extra !== undefined) {
    return null;
  }

  const ip = parseIp(rawIp);
  if (!ip) {
    return null;
  }

  const maxPrefix = ip.version === 4 ? 32 : 128;
  const prefixLength = rawPrefix === undefined ? maxPrefix : parsePrefix(rawPrefix, maxPrefix);
  if (prefixLength === null) {
    return null;
  }

  return { ...ip, prefixLength };
}

function parsePrefix(value: string, max: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const prefix = Number(value);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= max ? prefix : null;
}

function parseIp(value: string): ParsedIp | null {
  const normalized = stripIpv6Brackets(value.trim());
  if (normalized.includes(":")) {
    const bytes = parseIpv6(normalized);
    return bytes ? { version: 6, bytes } : null;
  }

  const bytes = parseIpv4(normalized);
  return bytes ? { version: 4, bytes } : null;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function normalizeIpv4MappedIp(ip: ParsedIp | null): ParsedIp | null {
  if (ip?.version !== 6) {
    return ip;
  }

  const isMapped =
    ip.bytes.slice(0, 10).every((byte) => byte === 0) &&
    ip.bytes[10] === 0xff &&
    ip.bytes[11] === 0xff;
  return isMapped ? { version: 4, bytes: ip.bytes.slice(12) } : ip;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const bytes = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const byte = Number(part);
    return byte >= 0 && byte <= 255 ? byte : null;
  });

  return bytes.every((byte): byte is number => byte !== null) ? bytes : null;
}

function parseIpv6(value: string): number[] | null {
  if (value.includes("%")) {
    return null;
  }

  const halves = value.split("::");
  if (halves.length > 2) {
    return null;
  }

  const head = parseIpv6Side(halves[0]);
  const tail = halves.length === 2 ? parseIpv6Side(halves[1]) : [];
  if (!head || !tail) {
    return null;
  }

  const missingGroups = 8 - head.length - tail.length;
  let groups: number[] | null = null;
  if (halves.length === 2 && missingGroups >= 1) {
    groups = [...head, ...Array(missingGroups).fill(0), ...tail];
  } else if (halves.length === 1 && head.length === 8) {
    groups = head;
  }

  if (groups?.length !== 8) {
    return null;
  }

  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function parseIpv6Side(value: string): number[] | null {
  if (!value) {
    return [];
  }

  const groups: number[] = [];
  const parts = value.split(":");

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.includes(".")) {
      if (index !== parts.length - 1) {
        return null;
      }

      const ipv4 = parseIpv4(part);
      if (!ipv4) {
        return null;
      }

      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      return null;
    }

    groups.push(Number.parseInt(part, 16));
  }

  return groups.length <= 8 ? groups : null;
}

function matchesPrefix(bytes: number[], range: ParsedIpRange): boolean {
  const fullBytes = Math.floor(range.prefixLength / 8);
  const remainingBits = range.prefixLength % 8;

  for (let index = 0; index < fullBytes; index++) {
    if (bytes[index] !== range.bytes[index]) {
      return false;
    }
  }

  if (remainingBits === 0) {
    return true;
  }

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[fullBytes] & mask) === (range.bytes[fullBytes] & mask);
}
