import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesAacStructure,
  matchesAmrStructure,
  matchesMpegAudioStructure,
  matchesOggStructure,
} from "../src/media/media-audio-structure.js";

const OGG_CRC_TABLE = buildOggCrcTable();

async function withTempFile<T>(bytes: Buffer, operation: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-audio-structure-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  try {
    return await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rawOggPage(options: {
  serial?: number;
  sequence?: number;
  headerType?: number;
  lacing: number[];
  body?: Buffer;
}): Buffer {
  const body = options.body ?? Buffer.alloc(options.lacing.reduce((sum, value) => sum + value, 0));
  if (body.length !== options.lacing.reduce((sum, value) => sum + value, 0)) {
    throw new Error("test Ogg body must equal the lacing sum");
  }
  const page = Buffer.alloc(27 + options.lacing.length + body.length);
  page.write("OggS", 0, 4, "ascii");
  page[4] = 0;
  page[5] = options.headerType ?? 0x06;
  page.writeBigInt64LE(0n, 6);
  page.writeUInt32LE(options.serial ?? 7, 14);
  page.writeUInt32LE(options.sequence ?? 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = options.lacing.length;
  Buffer.from(options.lacing).copy(page, 27);
  body.copy(page, 27 + options.lacing.length);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function oggPage(options?: {
  serial?: number;
  sequence?: number;
  headerType?: number;
  body?: Buffer;
}): Buffer {
  const body = options?.body ?? Buffer.from("OpusHead", "ascii");
  if (body.length > 254) {
    throw new Error("test Ogg page body must fit one terminating lacing value");
  }
  return rawOggPage({
    serial: options?.serial,
    sequence: options?.sequence,
    headerType: options?.headerType,
    lacing: [body.length],
    body,
  });
}

function oggCrc(page: Buffer): number {
  let crc = 0;
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index <= 25 ? 0 : page[index]!;
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc;
}

function buildOggCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = (index << 24) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 0x80000000) !== 0
          ? (((value << 1) >>> 0) ^ 0x04c11db7) >>> 0
          : (value << 1) >>> 0;
    }
    table[index] = value;
  }
  return table;
}

function adtsFrame(payload = Buffer.alloc(8), options?: { protectionAbsent?: boolean }): Buffer {
  const protectionAbsent = options?.protectionAbsent ?? true;
  const headerBytes = protectionAbsent ? 7 : 9;
  const frameBytes = headerBytes + payload.length;
  const header = Buffer.alloc(headerBytes);
  header[0] = 0xff;
  header[1] = protectionAbsent ? 0xf1 : 0xf0;
  header[2] = 0x50;
  header[3] = 0x80 | ((frameBytes >> 11) & 0x03);
  header[4] = (frameBytes >> 3) & 0xff;
  header[5] = ((frameBytes & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;
  if (!protectionAbsent) {
    header[7] = 0x12;
    header[8] = 0x34;
  }
  return Buffer.concat([header, payload]);
}

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.bits.push((value >> bit) & 1);
    }
  }

  align(): void {
    while (this.bits.length % 8 !== 0) {
      this.bits.push(0);
    }
  }

  toBuffer(): Buffer {
    this.align();
    const result = Buffer.alloc(this.bits.length / 8);
    for (let index = 0; index < this.bits.length; index += 1) {
      if (this.bits[index]) {
        result[Math.floor(index / 8)]! |= 1 << (7 - (index % 8));
      }
    }
    return result;
  }
}

function minimalAdif(): Buffer {
  const bits = new BitWriter();
  bits.write(0, 1);
  bits.write(0, 1);
  bits.write(0, 1);
  bits.write(1, 1);
  bits.write(128_000, 23);
  bits.write(0, 4);

  bits.write(0, 4);
  bits.write(1, 2);
  bits.write(4, 4);
  bits.write(1, 4);
  bits.write(0, 4);
  bits.write(0, 4);
  bits.write(0, 2);
  bits.write(0, 3);
  bits.write(0, 4);
  bits.write(0, 1);
  bits.write(0, 1);
  bits.write(0, 1);
  bits.write(0, 1);
  bits.write(0, 4);
  bits.align();
  bits.write(0, 8);

  return Buffer.concat([Buffer.from("ADIF", "ascii"), bits.toBuffer(), Buffer.from([0x21])]);
}

function mpeg1Layer3Frame(): Buffer {
  const frameBytes = Math.floor((144 * 128_000) / 44_100);
  const frame = Buffer.alloc(frameBytes);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame, 0);
  return frame;
}

function id3v2Tag(payload = Buffer.from("test", "ascii")): Buffer {
  if (payload.length >= 128) {
    throw new Error("test ID3 payload must fit one synchsafe byte");
  }
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, payload.length]),
    payload,
  ]);
}

function amrNbFrame(frameType = 2, payload?: Buffer): Buffer {
  const payloadBytes = payload ?? Buffer.alloc(15);
  return Buffer.concat([Buffer.from([(frameType << 3) | 0x04]), payloadBytes]);
}

function amrWbFrame(frameType = 9, payload?: Buffer): Buffer {
  const payloadBytes = payload ?? Buffer.alloc(5);
  return Buffer.concat([Buffer.from([(frameType << 3) | 0x04]), payloadBytes]);
}

describe("Ogg structure validation", () => {
  it("accepts a complete checksummed Ogg page", async () => {
    await withTempFile(oggPage(), async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects a page with a bad CRC", async () => {
    const page = oggPage();
    page[page.length - 1]! ^= 0x01;
    await withTempFile(page, async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(false);
    });
  });

  it("requires BOS on the first page and EOS by end of file", async () => {
    await withTempFile(oggPage({ headerType: 0x04 }), async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(false);
    });
    await withTempFile(oggPage({ headerType: 0x02 }), async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects an empty page that attempts to terminate a continued packet", async () => {
    const first = rawOggPage({
      serial: 9,
      sequence: 0,
      headerType: 0x02,
      lacing: [255],
      body: Buffer.alloc(255, 0x11),
    });
    const invalidEnd = rawOggPage({
      serial: 9,
      sequence: 1,
      headerType: 0x05,
      lacing: [],
      body: Buffer.alloc(0),
    });
    await withTempFile(Buffer.concat([first, invalidEnd]), async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects trailing bytes after the final page", async () => {
    await withTempFile(Buffer.concat([oggPage(), Buffer.from([0])]), async (filePath) => {
      await expect(matchesOggStructure(filePath)).resolves.toBe(false);
    });
  });
});

describe("AAC structure validation", () => {
  it("accepts consecutive ADTS frames with and without CRC headers", async () => {
    const aac = Buffer.concat([adtsFrame(), adtsFrame(Buffer.alloc(12), { protectionAbsent: false })]);
    await withTempFile(aac, async (filePath) => {
      await expect(matchesAacStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects truncated ADTS frames and reserved or escape sampling-frequency indices", async () => {
    const frame = adtsFrame();
    await withTempFile(frame.subarray(0, frame.length - 1), async (filePath) => {
      await expect(matchesAacStructure(filePath)).resolves.toBe(false);
    });

    for (const index of [13, 14, 15]) {
      const invalid = Buffer.from(frame);
      invalid[2] = (invalid[2]! & 0xc3) | (index << 2);
      await withTempFile(invalid, async (filePath) => {
        await expect(matchesAacStructure(filePath)).resolves.toBe(false);
      });
    }
  });

  it("accepts a bounded ADIF header with one program configuration and remaining audio data", async () => {
    await withTempFile(minimalAdif(), async (filePath) => {
      await expect(matchesAacStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects ADIF with no data after its parsed header", async () => {
    const adif = minimalAdif();
    await withTempFile(adif.subarray(0, adif.length - 1), async (filePath) => {
      await expect(matchesAacStructure(filePath)).resolves.toBe(false);
    });
  });
});

describe("MPEG audio structure validation", () => {
  it("accepts exact MPEG Layer III frames with optional ID3v2 and ID3v1 tags", async () => {
    const frame = mpeg1Layer3Frame();
    const id3v1 = Buffer.concat([Buffer.from("TAG", "ascii"), Buffer.alloc(125)]);
    const mp3 = Buffer.concat([id3v2Tag(), frame, frame, id3v1]);
    await withTempFile(mp3, async (filePath) => {
      await expect(matchesMpegAudioStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects prefix-only and truncated MPEG frames", async () => {
    await withTempFile(Buffer.from([0xff, 0xfb, 0x90, 0x64]), async (filePath) => {
      await expect(matchesMpegAudioStructure(filePath)).resolves.toBe(false);
    });
    const frame = mpeg1Layer3Frame();
    await withTempFile(frame.subarray(0, frame.length - 1), async (filePath) => {
      await expect(matchesMpegAudioStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects an ID3 tag without a following audio frame", async () => {
    await withTempFile(id3v2Tag(), async (filePath) => {
      await expect(matchesMpegAudioStructure(filePath)).resolves.toBe(false);
    });
  });
});

describe("AMR structure validation", () => {
  it("accepts narrowband and wideband storage frames", async () => {
    await withTempFile(Buffer.concat([Buffer.from("#!AMR\n", "ascii"), amrNbFrame()]), async (filePath) => {
      await expect(matchesAmrStructure(filePath)).resolves.toBe(true);
    });
    await withTempFile(Buffer.concat([Buffer.from("#!AMR-WB\n", "ascii"), amrWbFrame()]), async (filePath) => {
      await expect(matchesAmrStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects reserved narrowband frame types and truncated frames", async () => {
    await withTempFile(
      Buffer.concat([Buffer.from("#!AMR\n", "ascii"), amrNbFrame(9, Buffer.alloc(0))]),
      async (filePath) => {
        await expect(matchesAmrStructure(filePath)).resolves.toBe(false);
      },
    );
    const valid = Buffer.concat([Buffer.from("#!AMR\n", "ascii"), amrNbFrame()]);
    await withTempFile(valid.subarray(0, valid.length - 1), async (filePath) => {
      await expect(matchesAmrStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects non-zero storage padding bits", async () => {
    const payload = Buffer.alloc(15);
    payload[payload.length - 1] = 0x01;
    await withTempFile(
      Buffer.concat([Buffer.from("#!AMR\n", "ascii"), amrNbFrame(2, payload)]),
      async (filePath) => {
        await expect(matchesAmrStructure(filePath)).resolves.toBe(false);
      },
    );
  });
});
