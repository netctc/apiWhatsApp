import { open } from "node:fs/promises";

const FILE_TYPE_BOX = "ftyp";
const MOVIE_BOX = "moov";
const MEDIA_DATA_BOX = "mdat";
const MAX_FILE_TYPE_BOX_BYTES = 4096;
const MAX_TOP_LEVEL_BOXES = 4096;
const BASIC_BOX_HEADER_BYTES = 8;
const EXTENDED_BOX_HEADER_BYTES = 16;
const FILE_TYPE_FIXED_PAYLOAD_BYTES = 8;
const LEADING_BOX_TYPES = new Set(["free", "skip", "wide"]);

const MP4_BRANDS = new Set([
  "isom",
  "mp41",
  "mp42",
  "avc1",
  "M4A ",
  "M4B ",
  "M4V ",
  "dash",
  "piff",
  "dby1",
  "MSNV",
  "XAVC",
]);

export type IsoBmffMediaMimeType = "audio/mp4" | "video/mp4" | "video/3gpp";

interface BoxHeader {
  type: string;
  size: number;
  headerBytes: number;
}

interface FileTypeIdentity {
  majorBrand: string;
  compatibleBrands: string[];
}

export function matchesIsoBmffFileTypeSignature(
  sample: Buffer,
  mimeType: IsoBmffMediaMimeType,
): boolean {
  let offset = 0;
  let leadingBoxes = 0;

  while (offset + BASIC_BOX_HEADER_BYTES <= sample.length && leadingBoxes <= 8) {
    const header = parseBoxHeader(sample, offset, sample.length);
    if (!header) {
      return false;
    }

    if (header.type === FILE_TYPE_BOX) {
      if (header.size > MAX_FILE_TYPE_BOX_BYTES || offset + header.size > sample.length) {
        return false;
      }

      const box = sample.subarray(offset, offset + header.size);
      const identity = parseFileTypeBox(box, header.headerBytes);
      return identity ? matchesMimeFamily(identity, mimeType) : false;
    }

    if (!LEADING_BOX_TYPES.has(header.type)) {
      return false;
    }

    offset += header.size;
    leadingBoxes += 1;
  }

  return false;
}

export async function matchesIsoBmffStructure(
  filePath: string,
  mimeType: IsoBmffMediaMimeType,
): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 24) {
      return false;
    }

    let offset = 0;
    let boxCount = 0;
    let foundFileType = false;
    let foundMovie = false;
    let foundMediaData = false;

    while (offset < fileStat.size && boxCount < MAX_TOP_LEVEL_BOXES) {
      const fixedHeader = await readExactly(
        handle,
        Math.min(EXTENDED_BOX_HEADER_BYTES, fileStat.size - offset),
        offset,
      );
      if (!fixedHeader || fixedHeader.length < BASIC_BOX_HEADER_BYTES) {
        return false;
      }

      const header = parseBoxHeader(fixedHeader, 0, fileStat.size - offset, true);
      if (!header) {
        return false;
      }

      if (!foundFileType) {
        if (header.type !== FILE_TYPE_BOX && !LEADING_BOX_TYPES.has(header.type)) {
          return false;
        }
        if (header.type === FILE_TYPE_BOX) {
          if (header.size > MAX_FILE_TYPE_BOX_BYTES) {
            return false;
          }
          const box = await readExactly(handle, header.size, offset);
          if (!box) {
            return false;
          }
          const identity = parseFileTypeBox(box, header.headerBytes);
          if (!identity || !matchesMimeFamily(identity, mimeType)) {
            return false;
          }
          foundFileType = true;
        }
      } else if (header.type === FILE_TYPE_BOX) {
        return false;
      }

      foundMovie ||= header.type === MOVIE_BOX;
      foundMediaData ||= header.type === MEDIA_DATA_BOX;

      offset += header.size;
      boxCount += 1;
    }

    return (
      offset === fileStat.size &&
      boxCount > 0 &&
      boxCount < MAX_TOP_LEVEL_BOXES &&
      foundFileType &&
      foundMovie &&
      foundMediaData
    );
  } finally {
    await handle.close();
  }
}

function parseBoxHeader(
  bytes: Buffer,
  offset: number,
  availableFileBytes: number,
  allowZeroToEnd = false,
): BoxHeader | null {
  if (offset < 0 || offset + BASIC_BOX_HEADER_BYTES > bytes.length) {
    return null;
  }

  const size32 = bytes.readUInt32BE(offset);
  const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
  if (!isPrintableFourCc(type)) {
    return null;
  }

  if (size32 === 0) {
    if (!allowZeroToEnd || availableFileBytes < BASIC_BOX_HEADER_BYTES) {
      return null;
    }
    return { type, size: availableFileBytes, headerBytes: BASIC_BOX_HEADER_BYTES };
  }

  if (size32 === 1) {
    if (offset + EXTENDED_BOX_HEADER_BYTES > bytes.length) {
      return null;
    }
    const size64 = bytes.readBigUInt64BE(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const size = Number(size64);
    if (size < EXTENDED_BOX_HEADER_BYTES || size > availableFileBytes) {
      return null;
    }
    return { type, size, headerBytes: EXTENDED_BOX_HEADER_BYTES };
  }

  if (size32 < BASIC_BOX_HEADER_BYTES || size32 > availableFileBytes) {
    return null;
  }

  return { type, size: size32, headerBytes: BASIC_BOX_HEADER_BYTES };
}

function parseFileTypeBox(box: Buffer, headerBytes: number): FileTypeIdentity | null {
  const payloadBytes = box.length - headerBytes;
  if (
    payloadBytes < FILE_TYPE_FIXED_PAYLOAD_BYTES ||
    (payloadBytes - FILE_TYPE_FIXED_PAYLOAD_BYTES) % 4 !== 0
  ) {
    return null;
  }

  const majorBrand = box.subarray(headerBytes, headerBytes + 4).toString("latin1");
  if (!isPrintableFourCc(majorBrand)) {
    return null;
  }

  const compatibleBrands: string[] = [];
  for (let offset = headerBytes + FILE_TYPE_FIXED_PAYLOAD_BYTES; offset < box.length; offset += 4) {
    const brand = box.subarray(offset, offset + 4).toString("latin1");
    if (!isPrintableFourCc(brand)) {
      return null;
    }
    compatibleBrands.push(brand);
  }

  return { majorBrand, compatibleBrands };
}

function matchesMimeFamily(identity: FileTypeIdentity, mimeType: IsoBmffMediaMimeType): boolean {
  const brands = [identity.majorBrand, ...identity.compatibleBrands];

  if (mimeType === "video/3gpp") {
    return brands.some(is3gppBrand);
  }

  return brands.some(isMp4Brand);
}

function isMp4Brand(brand: string): boolean {
  return MP4_BRANDS.has(brand) || /^iso[2-9a-d]$/.test(brand) || /^cmf[2cfls]$/.test(brand);
}

function is3gppBrand(brand: string): boolean {
  return /^(?:3gp|3gr|3ge|3gg|3gh|3gm|3gs|3gt|3gv)[0-9A-Za-z]$/.test(brand);
}

function isPrintableFourCc(value: string): boolean {
  if (value.length !== 4) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;

  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      return null;
    }
    offset += bytesRead;
  }

  return buffer;
}
