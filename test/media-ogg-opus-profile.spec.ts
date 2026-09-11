import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesAudioStructure, matchesOggStructure } from "../src/media/media-audio-structure.js";
import { OggOpusProfile, matchesOpusPacketFraming } from "../src/media/media-ogg-opus-profile.js";

function head(): Buffer {
  const result = Buffer.alloc(19);
  result.write("OpusHead", 0, "ascii");
  result[8] = 1;
  result[9] = 1;
  result.writeUInt16LE(312, 10);
  result.writeUInt32LE(48_000, 12);
  return result;
}

function tags(length = 16): Buffer {
  const result = Buffer.alloc(length);
  result.write("OpusTags", 0, "ascii");
  return result;
}

function page(body: Buffer, options: {
  sequence?: number;
  flags?: number;
  granule?: bigint;
  serial?: number;
  lacing?: number[];
} = {}): Buffer {
  const lacing = options.lacing ?? [
    ...Array<number>(Math.floor(body.length / 255)).fill(255), body.length % 255,
  ];
  assert.ok(lacing.length <= 255);
  assert.equal(lacing.reduce((sum, length) => sum + length, 0), body.length);
  const result = Buffer.alloc(27 + lacing.length + body.length);
  result.write("OggS", 0, "ascii");
  result[5] = options.flags ?? 0;
  result.writeBigInt64LE(options.granule ?? 0n, 6);
  result.writeUInt32LE(options.serial ?? 7, 14);
  result.writeUInt32LE(options.sequence ?? 0, 18);
  result[26] = lacing.length;
  Buffer.from(lacing).copy(result, 27);
  body.copy(result, 27 + lacing.length);
  let crc = 0;
  for (const byte of result) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x80000000) !== 0 ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  result.writeUInt32LE(crc, 22);
  return result;
}

function stream(options: { id?: Buffer; comments?: Buffer; audio?: Buffer; serial?: number } = {}): Buffer {
  const serial = options.serial ?? 7;
  return Buffer.concat([
    page(options.id ?? head(), { serial, flags: 2 }),
    page(options.comments ?? tags(), { serial, sequence: 1 }),
    page(options.audio ?? Buffer.from([0xf8, 0xff, 0xfe]), {
      serial, sequence: 2, flags: 4, granule: 1272n,
    }),
  ]);
}

async function withFile(bytes: Buffer, run: (file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-opus-test-"));
  try {
    const file = join(directory, "audio.ogg");
    await writeFile(file, bytes);
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function accepts(bytes: Buffer, expected: boolean): Promise<void> {
  await withFile(bytes, async (file) => {
    assert.equal(await matchesAudioStructure(file, "audio/ogg"), expected);
  });
}

function splitTags(length: number): Buffer {
  const comments = tags(length);
  return Buffer.concat([
    page(head(), { flags: 2 }),
    page(comments.subarray(0, 65_025), { sequence: 1, granule: -1n, lacing: Array<number>(255).fill(255) }),
    page(comments.subarray(65_025), { sequence: 2, flags: 1 }),
    page(Buffer.from([0xf8, 0xff, 0xfe]), { sequence: 3, flags: 4, granule: 1272n }),
  ]);
}

function paddedPacket(length: number): Buffer {
  const fields = Math.ceil((length - 2) / 255);
  const padding = length - 2 - fields;
  return Buffer.concat([
    Buffer.from([0x83, 0x41]),
    Buffer.alloc(fields - 1, 255),
    Buffer.from([padding - 254 * (fields - 1)]),
    Buffer.alloc(padding),
  ]);
}

describe("Ogg Opus upload profile", () => {
  it("accepts a complete mono Opus stream through the MIME dispatcher", async () => {
    await accepts(stream(), true);
  });

  it("preserves the generic container helper but rejects codec-less uploads", async () => {
    const bytes = page(Buffer.from("OpusHead"), { flags: 6 });
    await withFile(bytes, async (file) => {
      assert.equal(await matchesOggStructure(file), true);
      assert.equal(await matchesAudioStructure(file, "audio/ogg"), false);
    });
  });

  for (const [name, offset, value] of [
    ["foreign codec", 0, 0], ["version zero", 8, 0], ["unsupported minor version", 8, 2],
    ["unsupported major version", 8, 16], ["zero channels", 9, 0], ["stereo", 9, 2],
    ["unsupported channel mapping", 18, 1],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const id = head();
      id[offset] = value;
      await accepts(stream({ id }), false);
    });
  }

  for (const length of [8, 18, 20]) {
    it(`rejects an identification packet of ${length} bytes`, async () => {
      const id = Buffer.alloc(length);
      head().copy(id);
      await accepts(stream({ id }), false);
    });
  }

  it("requires the identification header to be alone on its BOS page", async () => {
    await accepts(Buffer.concat([
      page(Buffer.concat([head(), tags()]), { flags: 2, lacing: [19, 16] }),
      page(Buffer.from([0xf8]), { sequence: 1, flags: 4, granule: 960n }),
    ]), false);
  });

  it("rejects missing comments and header-only streams", async () => {
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(Buffer.from([0xf8]), { sequence: 1, flags: 4, granule: 960n }),
    ]), false);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 1, flags: 4 }),
    ]), false);
  });

  it("validates vendor and comment lengths before accessing their fields", async () => {
    const vendorOverflow = tags();
    vendorOverflow.writeUInt32LE(0xffffffff, 8);
    const commentOverflow = tags();
    commentOverflow.writeUInt32LE(0xffffffff, 12);
    const truncatedComment = tags(20);
    truncatedComment.writeUInt32LE(1, 12);
    truncatedComment.writeUInt32LE(1, 16);
    for (const comments of [tags().subarray(0, 15), Buffer.alloc(16), vendorOverflow, commentOverflow, truncatedComment]) {
      await accepts(stream({ comments }), false);
    }
  });

  it("accepts vendor/comments plus RFC-permitted trailing tag padding", async () => {
    const comments = tags(40);
    comments.writeUInt32LE(3, 8);
    comments.write("enc", 12, "ascii");
    comments.writeUInt32LE(1, 15);
    comments.writeUInt32LE(3, 19);
    comments.write("A=B", 23, "ascii");
    comments[26] = 1;
    await accepts(stream({ comments }), true);
  });

  it("accepts continued comments at exactly 64 KiB and rejects one byte more", async () => {
    await accepts(splitTags(65_536), true);
    await accepts(splitTags(65_537), false);
  });

  it("requires the comment packet to end its page", async () => {
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }),
      page(Buffer.concat([tags(), Buffer.from([0xf8])]), { sequence: 1, flags: 4, lacing: [16, 1] }),
    ]), false);
  });

  it("accepts an audio packet split across pages, including a zero-length terminator", async () => {
    const packet = Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(254)]);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 1 }),
      page(packet, { sequence: 2, granule: -1n, lacing: [255] }),
      page(Buffer.alloc(0), { sequence: 3, flags: 5, granule: 960n, lacing: [0] }),
    ]), true);
  });

  it("rejects missing continuation flags even when CRCs remain valid", async () => {
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 1 }),
      page(Buffer.alloc(255, 0xf8), { sequence: 2, granule: -1n, lacing: [255] }),
      page(Buffer.alloc(0), { sequence: 3, flags: 4, granule: 960n, lacing: [0] }),
    ]), false);
  });

  it("rejects empty audio packets, malformed framing and missing EOS", async () => {
    await accepts(stream({ audio: Buffer.alloc(0) }), false);
    await accepts(stream({ audio: Buffer.from([0xfb, 0]) }), false);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 1 }),
      page(Buffer.from([0xf8]), { sequence: 2, granule: 960n }),
    ]), false);
  });

  it("rejects chained and multiplexed streams", async () => {
    await accepts(Buffer.concat([stream(), stream({ serial: 8 })]), false);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(head(), { serial: 8, flags: 2 }),
    ]), false);
  });

  it("preserves CRC, sequence, truncation and appended-data rejection", async () => {
    const corrupted = stream();
    corrupted[corrupted.length - 1]! ^= 1;
    await accepts(corrupted, false);
    await accepts(stream().subarray(0, stream().length - 1), false);
    await accepts(Buffer.concat([stream(), Buffer.from([0])]), false);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 2 }),
      page(Buffer.from([0xf8]), { sequence: 3, flags: 4, granule: 960n }),
    ]), false);
  });

  it("rejects nonzero header granules and missing granules on completed audio", async () => {
    await accepts(Buffer.concat([
      page(head(), { flags: 2, granule: 1n }), page(tags(), { sequence: 1 }),
      page(Buffer.from([0xf8]), { sequence: 2, flags: 4, granule: 960n }),
    ]), false);
    await accepts(Buffer.concat([
      page(head(), { flags: 2 }), page(tags(), { sequence: 1 }),
      page(Buffer.from([0xf8]), { sequence: 2, flags: 4, granule: -1n }),
    ]), false);
  });

  it("caps the number of audio packets without unbounded packet accumulation", () => {
    const profile = new OggOpusProfile();
    assert.equal(profile.acceptPage(page(head(), { flags: 2 })), true);
    assert.equal(profile.acceptPage(page(tags(), { sequence: 1 })), true);
    const audio = Buffer.alloc(250, 0xf8);
    for (let index = 0; index < 400; index += 1) {
      assert.equal(profile.acceptPage(page(audio, {
        sequence: index + 2, granule: BigInt((index + 1) * 250 * 960), lacing: Array<number>(250).fill(1),
      })), true);
    }
    assert.equal(profile.acceptPage(page(Buffer.from([0xf8]), {
      sequence: 402, flags: 4, granule: 96_000_960n,
    })), false);
  });
});

describe("Opus packet framing", () => {
  for (const [name, bytes] of [
    ["one frame", [0xf8, 0xff, 0xfe]], ["one PLC frame", [0xf8]],
    ["two CBR frames", [0xf9, 1, 2]], ["two PLC frames", [0xf9]],
    ["two VBR frames", [0xfa, 1, 1, 2]], ["two VBR PLC frames", [0xfa, 0]],
    ["multiple CBR frames", [0xfb, 2, 1, 2]], ["multiple VBR frames", [0xfb, 0x82, 1, 1, 2]],
    ["120ms boundary", [0xfb, 6]], ["48 short PLC frames", [0x83, 48]],
    ["padding", [0xfb, 0x41, 2, 7, 0, 0]],
    ["zero-length padding", [0xfb, 0x41, 0]],
  ] as const) {
    it(`accepts ${name}`, () => {
      assert.equal(matchesOpusPacketFraming(Buffer.from(bytes)), true);
    });
  }

  for (const [name, bytes] of [
    ["empty packet", []], ["odd CBR payload", [0xf9, 1]],
    ["missing VBR length", [0xfa]], ["truncated long VBR length", [0xfa, 252]],
    ["oversized VBR declaration", [0xfa, 10, 1]], ["missing count", [0xfb]],
    ["zero count", [0xfb, 0]], ["duration over 120ms", [0xfb, 7]],
    ["too many short frames", [0x83, 49]], ["indivisible CBR payload", [0xfb, 2, 1]],
    ["truncated padding length", [0xfb, 0x41]], ["missing padding", [0xfb, 0x41, 2, 0]],
    ["truncated padding chain", [0xfb, 0x41, 255]],
    ["missing multiple VBR lengths", [0xfb, 0x83, 0]],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(matchesOpusPacketFraming(Buffer.from(bytes)), false);
    });
  }

  it("accepts a two-byte VBR frame length", () => {
    assert.equal(matchesOpusPacketFraming(Buffer.concat([
      Buffer.from([0xfa, 252, 0]), Buffer.alloc(253),
    ])), true);
  });

  it("enforces 1275 bytes per frame for every packing code", () => {
    assert.equal(matchesOpusPacketFraming(Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(1275)])), true);
    for (const packet of [
      Buffer.concat([Buffer.from([0xf8]), Buffer.alloc(1276)]),
      Buffer.concat([Buffer.from([0xf9]), Buffer.alloc(2552)]),
      Buffer.concat([Buffer.from([0xfa, 0]), Buffer.alloc(1276)]),
      Buffer.concat([Buffer.from([0xfb, 1]), Buffer.alloc(1276)]),
      Buffer.concat([Buffer.from([0xfb, 0x82, 0]), Buffer.alloc(1276)]),
    ]) {
      assert.equal(matchesOpusPacketFraming(packet), false);
    }
  });

  it("accepts exactly 61440 bytes including padding and rejects one byte more", () => {
    assert.equal(matchesOpusPacketFraming(paddedPacket(61_440)), true);
    assert.equal(matchesOpusPacketFraming(paddedPacket(61_441)), false);
  });
});
