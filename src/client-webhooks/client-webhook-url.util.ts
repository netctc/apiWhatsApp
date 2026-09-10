import { isIP } from "node:net";

export class ClientWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientWebhookUrlError";
  }
}

export function normalizeClientWebhookUrl(input: string): string {
  if (input.length > 2048) {
    throw new ClientWebhookUrlError("Client webhook URL cannot exceed 2048 characters");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ClientWebhookUrlError("Client webhook URL must be an absolute URL");
  }

  const allowHttp = process.env.NODE_ENV === "test";
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ClientWebhookUrlError("Client webhook URL must use HTTPS");
  }
  if (!url.hostname) {
    throw new ClientWebhookUrlError("Client webhook URL requires a hostname");
  }
  if (url.username || url.password) {
    throw new ClientWebhookUrlError("Client webhook URL cannot contain embedded credentials");
  }
  if (url.hash) {
    throw new ClientWebhookUrlError("Client webhook URL cannot contain a fragment");
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!allowHttp && (hostname === "localhost" || hostname.endsWith(".localhost"))) {
    throw new ClientWebhookUrlError("Client webhook URL cannot target localhost");
  }

  return url.toString();
}

export function webhookUrlAuditMetadata(value: string): { host: string; port?: string } {
  const url = new URL(value);
  return {
    host: stripIpv6Brackets(url.hostname).toLowerCase(),
    ...(url.port ? { port: url.port } : {}),
  };
}

export function isPublicWebhookAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    return isPublicIpv4(normalized);
  }
  if (version === 6) {
    return isPublicIpv6(normalized);
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("fc") || address.startsWith("fd")) return false;
  if (/^fe[89ab]/u.test(address)) return false;
  if (address.startsWith("ff")) return false;
  if (address.startsWith("2001:db8:")) return false;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address)?.[1];
  if (mapped) {
    return isPublicIpv4(mapped);
  }
  return true;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
