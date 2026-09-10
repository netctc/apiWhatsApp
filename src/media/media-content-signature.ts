import { open } from "node:fs/promises";

const INSPECTION_BYTES = 8192;
const PDF_HEADER = Buffer.from("%PDF-", "ascii");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const OOXML_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const LEGACY_OFFICE_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

export class MediaContentSignatureError extends Error {
  constructor(readonly mimeType: string) {
    super(`Media file content does not match declared MIME type: ${mimeType}`);
    this.name = "MediaContentSignatureError";
  }
}

export async function assertMediaContentSignature(filePath: string, mimeType: string): Promise<void> {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const sample = await readPrefix(filePath);

  if (!matchesMimeSignature(sample, normalizedMimeType)) {
    throw new MediaContentSignatureError(normalizedMimeType);
  }
}

export function matchesMimeSignature(sample: Buffer, mimeType: string): boolean {
  if (sample.length === 0) {
    return false;
  }

  switch (mimeType) {
    case "image/jpeg":
      return startsWith(sample, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWithBuffer(sample, PNG_SIGNATURE);
    case "application/pdf":
      return sample.subarray(0, Math.min(sample.length, 1024)).indexOf(PDF_HEADER) >= 0;
    case "audio/ogg":
      return sample.subarray(0, 4).toString("ascii") === "OggS";
    case "audio/aac":
      return isAdtsAac(sample) || sample.subarray(0, 4).toString("ascii") === "ADIF";
    case "audio/mpeg":
      return isMp3(sample);
    case "audio/amr":
      return sample.subarray(0, 6).toString("ascii") === "#!AMR\n" ||
        sample.subarray(0, 9).toString("ascii") === "#!AMR-WB\n";
    case "audio/mp4":
    case "video/mp4":
      return isIsoBmff(sample);
    case "video/3gpp":
      return isIsoBmff(sample) && has3gppBrand(sample);
    case "text/plain":
      return !sample.includes(0x00);
    default:
      if (LEGACY_OFFICE_MIME_TYPES.has(mimeType)) {
        return startsWithBuffer(sample, OLE_SIGNATURE);
      }
      if (OOXML_MIME_TYPES.has(mimeType)) {
        return startsWithBuffer(sample, ZIP_LOCAL_HEADER);
      }
      return false;
  }
}

async function readPrefix(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(INSPECTION_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function startsWith(sample: Buffer, bytes: number[]): boolean {
  if (sample.length < bytes.length) {
    return false;
  }
  return bytes.every((value, index) => sample[index] === value);
}

function startsWithBuffer(sample: Buffer, signature: Buffer): boolean {
  return sample.length >= signature.length && sample.subarray(0, signature.length).equals(signature);
}

function isAdtsAac(sample: Buffer): boolean {
  if (sample.length < 2) {
    return false;
  }
  return sample[0] === 0xff && (sample[1] & 0xf6) === 0xf0;
}

function isMp3(sample: Buffer): boolean {
  if (sample.length >= 3 && sample.subarray(0, 3).toString("ascii") === "ID3") {
    return true;
  }
  if (sample.length < 2 || sample[0] !== 0xff || (sample[1] & 0xe0) !== 0xe0) {
    return false;
  }
  return (sample[1] & 0x06) !== 0;
}

function isIsoBmff(sample: Buffer): boolean {
  const maxOffset = Math.min(sample.length - 4, 64);
  for (let offset = 4; offset <= maxOffset; offset += 1) {
    if (sample.subarray(offset, offset + 4).toString("ascii") === "ftyp") {
      return true;
    }
  }
  return false;
}

function has3gppBrand(sample: Buffer): boolean {
  const ascii = sample.subarray(0, Math.min(sample.length, 96)).toString("ascii").toLowerCase();
  return ascii.includes("3gp") || ascii.includes("3g2");
}
