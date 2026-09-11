import { open } from "node:fs/promises";

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const JPEG_MAX_HEADER_MARKERS = 1024;
const JPEG_SOS = 0xda;
const JPEG_EOI_MARKER = 0xd9;
const JPEG_TEM = 0x01;
const JPEG_RST_MIN = 0xd0;
const JPEG_RST_MAX = 0xd7;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAX_CHUNKS = 10_000;
const PNG_CRC_READ_BYTES = 64 * 1024;
const PNG_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PNG_COLOR_GRAYSCALE = 0;
const PNG_COLOR_TRUECOLOR = 2;
const PNG_COLOR_INDEXED = 3;
const PNG_COLOR_GRAYSCALE_ALPHA = 4;
const PNG_COLOR_TRUECOLOR_ALPHA = 6;

const CRC32_TABLE = buildCrc32Table();

export async function matchesJpegStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 12) {
      return false;
    }

    const first = await readExactly(handle, JPEG_SOI.length, 0);
    const last = await readExactly(handle, JPEG_EOI.length, fileStat.size - JPEG_EOI.length);
    if (!first?.equals(JPEG_SOI) || !last?.equals(JPEG_EOI)) {
      return false;
    }

    let offset = JPEG_SOI.length;
    let markerCount = 0;
    let foundStartOfFrame = false;

    while (offset < fileStat.size - JPEG_EOI.length && markerCount < JPEG_MAX_HEADER_MARKERS) {
      const marker = await readJpegMarker(handle, offset, fileStat.size);
      if (!marker) {
        return false;
      }
      offset = marker.nextOffset;
      markerCount += 1;

      if (marker.code === JPEG_EOI_MARKER) {
        return false;
      }

      if (isStandaloneJpegMarker(marker.code)) {
        continue;
      }

      const lengthBytes = await readExactly(handle, 2, offset);
      if (!lengthBytes) {
        return false;
      }
      const segmentLength = lengthBytes.readUInt16BE(0);
      if (segmentLength < 2 || offset + segmentLength > fileStat.size - JPEG_EOI.length) {
        return false;
      }

      if (isStartOfFrameMarker(marker.code)) {
        if (!(await validateJpegStartOfFrame(handle, offset, segmentLength))) {
          return false;
        }
        foundStartOfFrame = true;
      }

      if (marker.code === JPEG_SOS) {
        return (
          foundStartOfFrame &&
          (await validateJpegStartOfScan(handle, offset, segmentLength)) &&
          offset + segmentLength < fileStat.size - JPEG_EOI.length
        );
      }

      offset += segmentLength;
    }

    return false;
  } finally {
    await handle.close();
  }
}

export async function matchesPngStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < PNG_SIGNATURE.length + 12) {
      return false;
    }

    const signature = await readExactly(handle, PNG_SIGNATURE.length, 0);
    if (!signature?.equals(PNG_SIGNATURE)) {
      return false;
    }

    let offset = PNG_SIGNATURE.length;
    let chunkCount = 0;
    let seenIhdr = false;
    let seenPlte = false;
    let seenIdat = false;
    let idatClosed = false;
    let colorType: number | null = null;

    while (offset < fileStat.size && chunkCount < PNG_MAX_CHUNKS) {
      const header = await readExactly(handle, 8, offset);
      if (!header) {
        return false;
      }

      const dataLength = header.readUInt32BE(0);
      const typeBytes = header.subarray(4, 8);
      const type = typeBytes.toString("ascii");
      if (!isPngChunkType(typeBytes)) {
        return false;
      }

      const dataOffset = offset + 8;
      const crcOffset = dataOffset + dataLength;
      const nextOffset = crcOffset + 4;
      if (nextOffset > fileStat.size) {
        return false;
      }

      if (chunkCount === 0 && type !== "IHDR") {
        return false;
      }
      if (isUnknownCriticalPngChunk(typeBytes, type)) {
        return false;
      }

      if (type === "IHDR") {
        if (seenIhdr || dataLength !== 13) {
          return false;
        }
        const ihdr = await readExactly(handle, dataLength, dataOffset);
        if (!ihdr || !validatePngIhdr(ihdr)) {
          return false;
        }
        colorType = ihdr[9] ?? null;
        seenIhdr = true;
      } else if (!seenIhdr) {
        return false;
      }

      if (type === "PLTE") {
        if (
          seenPlte ||
          seenIdat ||
          dataLength === 0 ||
          dataLength > 768 ||
          dataLength % 3 !== 0 ||
          colorType === PNG_COLOR_GRAYSCALE ||
          colorType === PNG_COLOR_GRAYSCALE_ALPHA
        ) {
          return false;
        }
        seenPlte = true;
      }

      if (type === "IDAT") {
        if (idatClosed || (colorType === PNG_COLOR_INDEXED && !seenPlte)) {
          return false;
        }
        seenIdat = true;
      } else if (seenIdat && type !== "IEND") {
        idatClosed = true;
      }

      if (!(await validatePngChunkCrc(handle, typeBytes, dataOffset, dataLength, crcOffset))) {
        return false;
      }

      if (type === "IEND") {
        return dataLength === 0 && seenIdat && nextOffset === fileStat.size;
      }

      offset = nextOffset;
      chunkCount += 1;
    }

    return false;
  } finally {
    await handle.close();
  }
}

async function readJpegMarker(
  handle: Awaited<ReturnType<typeof open>>,
  startOffset: number,
  fileSize: number,
): Promise<{ code: number; nextOffset: number } | null> {
  let offset = startOffset;
  const first = await readExactly(handle, 1, offset);
  if (!first || first[0] !== 0xff) {
    return null;
  }

  while (offset < fileSize) {
    const byte = await readExactly(handle, 1, offset);
    if (!byte) {
      return null;
    }
    if (byte[0] === 0xff) {
      offset += 1;
      continue;
    }
    if (byte[0] === 0x00) {
      return null;
    }
    return { code: byte[0] ?? 0, nextOffset: offset + 1 };
  }

  return null;
}

function isStandaloneJpegMarker(code: number): boolean {
  return code === JPEG_TEM || (code >= JPEG_RST_MIN && code <= JPEG_RST_MAX);
}

function isStartOfFrameMarker(code: number): boolean {
  return (
    (code >= 0xc0 && code <= 0xc3) ||
    (code >= 0xc5 && code <= 0xc7) ||
    (code >= 0xc9 && code <= 0xcb) ||
    (code >= 0xcd && code <= 0xcf)
  );
}

async function validateJpegStartOfFrame(
  handle: Awaited<ReturnType<typeof open>>,
  lengthOffset: number,
  segmentLength: number,
): Promise<boolean> {
  if (segmentLength < 8) {
    return false;
  }
  const fixed = await readExactly(handle, 8, lengthOffset);
  if (!fixed) {
    return false;
  }

  const height = fixed.readUInt16BE(3);
  const width = fixed.readUInt16BE(5);
  const components = fixed[7] ?? 0;
  return width > 0 && height > 0 && components > 0 && segmentLength === 8 + components * 3;
}

async function validateJpegStartOfScan(
  handle: Awaited<ReturnType<typeof open>>,
  lengthOffset: number,
  segmentLength: number,
): Promise<boolean> {
  if (segmentLength < 8) {
    return false;
  }
  const prefix = await readExactly(handle, 3, lengthOffset);
  if (!prefix) {
    return false;
  }
  const components = prefix[2] ?? 0;
  return components > 0 && segmentLength === 6 + components * 2;
}

function validatePngIhdr(ihdr: Buffer): boolean {
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8] ?? 0;
  const colorType = ihdr[9] ?? 255;
  const compressionMethod = ihdr[10] ?? 255;
  const filterMethod = ihdr[11] ?? 255;
  const interlaceMethod = ihdr[12] ?? 255;

  if (
    width === 0 ||
    height === 0 ||
    compressionMethod !== 0 ||
    filterMethod !== 0 ||
    (interlaceMethod !== 0 && interlaceMethod !== 1)
  ) {
    return false;
  }

  switch (colorType) {
    case PNG_COLOR_GRAYSCALE:
      return [1, 2, 4, 8, 16].includes(bitDepth);
    case PNG_COLOR_TRUECOLOR:
    case PNG_COLOR_GRAYSCALE_ALPHA:
    case PNG_COLOR_TRUECOLOR_ALPHA:
      return bitDepth === 8 || bitDepth === 16;
    case PNG_COLOR_INDEXED:
      return [1, 2, 4, 8].includes(bitDepth);
    default:
      return false;
  }
}

function isPngChunkType(type: Buffer): boolean {
  if (type.length !== 4) {
    return false;
  }
  for (const value of type) {
    const alphabetic = (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
    if (!alphabetic) {
      return false;
    }
  }
  return true;
}

function isUnknownCriticalPngChunk(typeBytes: Buffer, type: string): boolean {
  const firstByte = typeBytes[0] ?? 0;
  const critical = firstByte >= 0x41 && firstByte <= 0x5a;
  return critical && !PNG_CRITICAL_CHUNKS.has(type);
}

async function validatePngChunkCrc(
  handle: Awaited<ReturnType<typeof open>>,
  typeBytes: Buffer,
  dataOffset: number,
  dataLength: number,
  crcOffset: number,
): Promise<boolean> {
  let crc = updateCrc32(0xffffffff, typeBytes);
  let readOffset = 0;

  while (readOffset < dataLength) {
    const length = Math.min(PNG_CRC_READ_BYTES, dataLength - readOffset);
    const chunk = await readExactly(handle, length, dataOffset + readOffset);
    if (!chunk) {
      return false;
    }
    crc = updateCrc32(crc, chunk);
    readOffset += length;
  }

  const expectedBytes = await readExactly(handle, 4, crcOffset);
  if (!expectedBytes) {
    return false;
  }
  const expected = expectedBytes.readUInt32BE(0);
  const actual = (crc ^ 0xffffffff) >>> 0;
  return actual === expected;
}

function updateCrc32(initial: number, bytes: Buffer): number {
  let crc = initial >>> 0;
  for (const value of bytes) {
    crc = (CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
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
