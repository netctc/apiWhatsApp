import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesJpegStructure,
  matchesPngStructure,
} from "../src/media/media-image-structure.js";
import { minimalJpeg } from "./helpers/media-fixtures.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = buildCrc32Table();

function pngChunk(type: string, data = Buffer.alloc(0), corruptCrc = false): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBytes = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBytes, data]));
  crcBytes.writeUInt32BE(corruptCrc ? (crc ^ 0xffffffff) >>> 0 : crc, 0);
  return Buffer.concat([length, typeBytes, data, crcBytes]);
}

function ihdr(options?: { width?: number; height?: number; bitDepth?: number; colorType?: number }): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(options?.width ?? 1, 0);
  data.writeUInt32BE(options?.height ?? 1, 4);
  data[8] = options?.bitDepth ?? 8;
  data[9] = options?.colorType ?? 2;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return pngChunk("IHDR", data);
}

function minimalPng(options?: {
  ihdrChunk?: Buffer;
  beforeIdat?: Buffer[];
  idatChunks?: Buffer[];
  afterIdat?: Buffer[];
  trailing?: Buffer;
}): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    options?.ihdrChunk ?? ihdr(),
    ...(options?.beforeIdat ?? []),
    ...(options?.idatChunks ?? [pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x01]))]),
    ...(options?.afterIdat ?? []),
    pngChunk("IEND"),
    options?.trailing ?? Buffer.alloc(0),
  ]);
}

async function withTempFile<T>(
  bytes: Buffer,
  operation: (filePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-image-structure-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  try {
    return await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("JPEG structure validation", () => {
  it("accepts a minimal JPEG with SOF, SOS, entropy data and final EOI", async () => {
    await withTempFile(minimalJpeg(), async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects a JPEG without final EOI", async () => {
    const jpeg = minimalJpeg();
    await withTempFile(jpeg.subarray(0, jpeg.length - 2), async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects bytes appended after EOI", async () => {
    const jpeg = Buffer.concat([minimalJpeg(), Buffer.from("trailing", "ascii")]);
    await withTempFile(jpeg, async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects SOS before any start-of-frame marker", async () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      Buffer.from([0x01, 0xff, 0xd9]),
    ]);
    await withTempFile(jpeg, async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects zero dimensions in the start-of-frame marker", async () => {
    const jpeg = minimalJpeg();
    const zeroWidth = Buffer.from(jpeg);
    zeroWidth.writeUInt16BE(0, 9);
    await withTempFile(zeroWidth, async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects a truncated or inconsistent start-of-frame segment", async () => {
    const jpeg = minimalJpeg();
    const badLength = Buffer.from(jpeg);
    badLength.writeUInt16BE(10, 4);
    await withTempFile(badLength, async (filePath) => {
      await expect(matchesJpegStructure(filePath)).resolves.toBe(false);
    });
  });
});

describe("PNG structure validation", () => {
  it("accepts a bounded truecolor PNG with valid CRCs", async () => {
    await withTempFile(minimalPng(), async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects a chunk with an invalid CRC", async () => {
    const png = minimalPng({
      idatChunks: [pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x01]), true)],
    });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects PNGs without IDAT", async () => {
    await withTempFile(minimalPng({ idatChunks: [] }), async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects bytes after IEND", async () => {
    await withTempFile(
      minimalPng({ trailing: Buffer.from("polyglot", "ascii") }),
      async (filePath) => {
        await expect(matchesPngStructure(filePath)).resolves.toBe(false);
      },
    );
  });

  it("rejects an unknown critical chunk", async () => {
    const png = minimalPng({ beforeIdat: [pngChunk("ABCD", Buffer.from([0x01]))] });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects chunk types with the reserved bit set", async () => {
    const png = minimalPng({ beforeIdat: [pngChunk("abcD", Buffer.from([0x01]))] });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("requires PLTE before IDAT for indexed-color PNG", async () => {
    const png = minimalPng({ ihdrChunk: ihdr({ colorType: 3, bitDepth: 8 }) });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("accepts indexed-color PNG when a bounded PLTE precedes IDAT", async () => {
    const png = minimalPng({
      ihdrChunk: ihdr({ colorType: 3, bitDepth: 8 }),
      beforeIdat: [pngChunk("PLTE", Buffer.from([0xff, 0x00, 0x00]))],
    });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects indexed palettes larger than the declared bit depth permits", async () => {
    const png = minimalPng({
      ihdrChunk: ihdr({ colorType: 3, bitDepth: 1 }),
      beforeIdat: [
        pngChunk(
          "PLTE",
          Buffer.from([
            0xff, 0x00, 0x00,
            0x00, 0xff, 0x00,
            0x00, 0x00, 0xff,
          ]),
        ),
      ],
    });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects non-consecutive IDAT chunks", async () => {
    const png = minimalPng({
      idatChunks: [pngChunk("IDAT", Buffer.from([0x01]))],
      afterIdat: [pngChunk("tEXt", Buffer.from("k\u0000v", "latin1")), pngChunk("IDAT", Buffer.from([0x02]))],
    });
    await withTempFile(png, async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects a truncated chunk body", async () => {
    const png = minimalPng();
    await withTempFile(png.subarray(0, png.length - 3), async (filePath) => {
      await expect(matchesPngStructure(filePath)).resolves.toBe(false);
    });
  });
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = (CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
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
