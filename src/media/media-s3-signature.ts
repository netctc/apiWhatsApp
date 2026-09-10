import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

export interface S3SignatureInput {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  date: Date;
  headers?: Record<string, string>;
  sessionToken?: string;
}

export interface S3SignedHeaders {
  headers: Record<string, string>;
  authorization: string;
}

export function createS3SignedHeaders(input: S3SignatureInput): S3SignedHeaders {
  const amzDate = formatAmzDate(input.date);
  const dateStamp = amzDate.slice(0, 8);
  const headers = normalizeHeaders({
    ...(input.headers ?? {}),
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": amzDate,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
  });
  const signedHeaderNames = Object.keys(headers).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname || "/",
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(Buffer.from(`AWS4${input.secretAccessKey}`, "utf8"), dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    headers,
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => {
      if (nameA !== nameB) {
        return nameA < nameB ? -1 : 1;
      }
      if (valueA === valueB) {
        return 0;
      }
      return valueA < valueB ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  return normalized;
}

function awsUriEncode(value: string): string {
  let result = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/^[A-Za-z0-9._~-]$/.test(char)) {
      result += char;
    } else {
      result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return result;
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}
