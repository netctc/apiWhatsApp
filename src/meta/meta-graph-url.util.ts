import type { ConfigService } from "@nestjs/config";

const DEFAULT_META_GRAPH_BASE_URL = "https://graph.facebook.com";

export function metaGraphUrl(config: ConfigService, path: string): URL {
  const configured = config.get<string>("META_GRAPH_API_BASE_URL")?.trim();
  const base = configured || DEFAULT_META_GRAPH_BASE_URL;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("META_GRAPH_API_BASE_URL must be a valid absolute URL");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("META_GRAPH_API_BASE_URL must not contain credentials, query parameters, or fragments");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.NODE_ENV === "test")) {
    throw new Error("META_GRAPH_API_BASE_URL must use HTTPS outside NODE_ENV=test");
  }

  const normalizedBase = url.toString().replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(`${normalizedBase}/${normalizedPath}`);
}
