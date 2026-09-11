/** Deterministic, checksummed Ogg fixtures; no codec executable is needed in CI. */
function page(body: Buffer, options: {
  flags?: number;
  sequence?: number;
  serial?: number;
  granule?: bigint;
  lacing?: number[];
} = {}): Buffer {
  const lacing = options.lacing ?? [
    ...Array<number>(Math.floor(body.length / 255)).fill(255), body.length % 255,
  ];
  if (lacing.length > 255 || lacing.some((value) => !Number.isInteger(value) || value < 0 || value > 255) ||
      lacing.reduce((sum, value) => sum + value, 0) !== body.length) {
    throw new Error("Invalid Ogg fixture lacing");
  }
  const bytes = Buffer.alloc(27 + lacing.length + body.length);
  bytes.write("OggS", 0, "ascii");
  bytes[5] = options.flags ?? 0;
  bytes.writeBigInt64LE(options.granule ?? 0n, 6);
  bytes.writeUInt32LE(options.serial ?? 17, 14);
  bytes.writeUInt32LE(options.sequence ?? 0, 18);
  bytes[26] = lacing.length;
  Buffer.from(lacing).copy(bytes, 27);
  body.copy(bytes, 27 + lacing.length);
  let crc = 0;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ ((crc & 0x80000000) !== 0 ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  bytes.writeUInt32LE(crc, 22);
  return bytes;
}

function head(channels = 1): Buffer {
  const bytes = Buffer.alloc(19);
  bytes.write("OpusHead", 0, "ascii");
  bytes[8] = 1;
  bytes[9] = channels;
  bytes.writeUInt16LE(312, 10);
  bytes.writeUInt32LE(48_000, 12);
  return bytes;
}

function tags(vendor = "apiWhatsApp-test", size?: number): Buffer {
  const text = Buffer.from(vendor, "utf8");
  const minimum = 16 + text.length;
  if (size !== undefined && (!Number.isInteger(size) || size < minimum || size > 65_537)) {
    throw new Error("Invalid Opus fixture comment size");
  }
  const bytes = Buffer.alloc(size ?? minimum);
  bytes.write("OpusTags", 0, "ascii");
  bytes.writeUInt32LE(text.length, 8);
  text.copy(bytes, 12);
  // The zero comment count follows the vendor. Remaining bytes are tag padding.
  return bytes;
}

function stream(options: { id?: Buffer; comments?: Buffer; audio?: Buffer; serial?: number } = {}): Buffer {
  const serial = options.serial ?? 17;
  const comments = options.comments ?? tags();
  const pages = [page(options.id ?? head(), { flags: 2, serial })];
  let sequence = 1;
  if (comments.length >= 65_025) {
    pages.push(page(comments.subarray(0, 65_025), {
      sequence: sequence++, serial, granule: -1n, lacing: Array<number>(255).fill(255),
    }));
    pages.push(page(comments.subarray(65_025), { sequence: sequence++, serial, flags: 1 }));
  } else {
    pages.push(page(comments, { sequence: sequence++, serial }));
  }
  // One 20 ms mono silence packet, 960 decoded samples at 48 kHz.
  pages.push(page(options.audio ?? Buffer.from([0xf8, 0xff, 0xfe]), {
    sequence, serial, flags: 4, granule: 960n,
  }));
  return Buffer.concat(pages);
}

export function validOggOpus(options: { vendor?: string; tagBytes?: number } = {}): Buffer {
  return stream({ comments: tags(options.vendor, options.tagBytes) });
}

export interface InvalidOggOpusFixture {
  name: string;
  bytes: Buffer;
  containerValid: boolean;
}

export function invalidOggOpusFixtures(): InvalidOggOpusFixture[] {
  const corrupt = stream();
  corrupt[corrupt.length - 1]! ^= 1;
  const foreign = head();
  foreign.write("NotOpus!", 0, "ascii");
  const overflow = tags();
  overflow.writeUInt32LE(0xffffffff, 8);
  const wrongMapping = head();
  wrongMapping[18] = 1;
  return [
    { name: "codec-less Ogg", bytes: page(Buffer.from("OpusHead"), { flags: 6 }), containerValid: true },
    { name: "foreign codec header", bytes: stream({ id: foreign }), containerValid: true },
    { name: "stereo output", bytes: stream({ id: head(2) }), containerValid: true },
    { name: "unsupported mapping", bytes: stream({ id: wrongMapping }), containerValid: true },
    { name: "vendor length overflow", bytes: stream({ comments: overflow }), containerValid: true },
    { name: "oversized continued tags", bytes: stream({ comments: tags("", 65_537) }), containerValid: true },
    { name: "invalid audio framing", bytes: stream({ audio: Buffer.from([0xfb, 0]) }), containerValid: true },
    { name: "empty audio packet", bytes: stream({ audio: Buffer.alloc(0) }), containerValid: true },
    { name: "missing comments", bytes: Buffer.concat([
      page(head(), { flags: 2 }),
      page(Buffer.from([0xf8, 0xff, 0xfe]), { sequence: 1, flags: 4, granule: 960n }),
    ]), containerValid: true },
    { name: "chained streams", bytes: Buffer.concat([stream(), stream({ serial: 18 })]), containerValid: true },
    { name: "invalid CRC", bytes: corrupt, containerValid: false },
    { name: "truncated page", bytes: stream().subarray(0, -1), containerValid: false },
    { name: "trailing bytes", bytes: Buffer.concat([stream(), Buffer.from([0])]), containerValid: false },
  ];
}
