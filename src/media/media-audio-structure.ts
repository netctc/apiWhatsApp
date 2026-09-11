import { open } from "node:fs/promises";

export type StructuredAudioMimeType = "audio/ogg" | "audio/aac" | "audio/mpeg" | "audio/amr";

const OGG_CAPTURE = Buffer.from("OggS", "ascii");
const OGG_FIXED_HEADER_BYTES = 27;
const OGG_MAX_PAGE_BYTES = 65_307;
const OGG_MAX_PAGES = 100_000;
const OGG_BOS = 0x02;
const OGG_EOS = 0x04;
const OGG_CONTINUED = 0x01;
const OGG_CRC_TABLE = buildOggCrcTable();

const AAC_ADIF = Buffer.from("ADIF", "ascii");
const AAC_MAX_FRAMES = 100_000;
const AAC_ADIF_INSPECTION_BYTES = 64 * 1024;

const MP3_ID3V2 = Buffer.from("ID3", "ascii");
const MP3_ID3V1 = Buffer.from("TAG", "ascii");
const MP3_ID3V1_BYTES = 128;
const MP3_MAX_FRAMES = 100_000;
const MPEG1_LAYER1_BITRATES = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const MPEG1_LAYER2_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_LAYER1_BITRATES = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const MPEG2_LAYER23_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000];

const AMR_NB_MAGIC = Buffer.from("#!AMR\n", "ascii");
const AMR_WB_MAGIC = Buffer.from("#!AMR-WB\n", "ascii");
const AMR_MAX_FRAMES = 100_000;
const AMR_NB_FRAME_BITS = [95, 103, 118, 134, 148, 159, 204, 244, 39];
const AMR_WB_FRAME_BITS = [132, 177, 253, 285, 317, 365, 397, 461, 477, 40];

interface OggStreamState {
  nextSequence: number;
  continuedPacket: boolean;
  ended: boolean;
}

export async function matchesAudioStructure(
  filePath: string,
  mimeType: StructuredAudioMimeType,
): Promise<boolean> {
  switch (mimeType) {
    case "audio/ogg":
      return matchesOggStructure(filePath);
    case "audio/aac":
      return matchesAacStructure(filePath);
    case "audio/mpeg":
      return matchesMpegAudioStructure(filePath);
    case "audio/amr":
      return matchesAmrStructure(filePath);
  }
}

export async function matchesOggStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < OGG_FIXED_HEADER_BYTES + 1) {
      return false;
    }

    const streams = new Map<number, OggStreamState>();
    let offset = 0;
    let pages = 0;
    let sawPayload = false;

    while (offset < stat.size && pages < OGG_MAX_PAGES) {
      const fixed = await readExactly(handle, OGG_FIXED_HEADER_BYTES, offset);
      if (!fixed || !fixed.subarray(0, 4).equals(OGG_CAPTURE) || fixed[4] !== 0) {
        return false;
      }

      const headerType = fixed[5] ?? 0;
      if ((headerType & ~0x07) !== 0) {
        return false;
      }

      const segmentCount = fixed[26] ?? 0;
      const lacing = await readExactly(handle, segmentCount, offset + OGG_FIXED_HEADER_BYTES);
      if (!lacing) {
        return false;
      }
      const bodyBytes = lacing.reduce((sum, value) => sum + value, 0);
      const pageBytes = OGG_FIXED_HEADER_BYTES + segmentCount + bodyBytes;
      if (pageBytes > OGG_MAX_PAGE_BYTES || offset + pageBytes > stat.size) {
        return false;
      }

      const page = await readExactly(handle, pageBytes, offset);
      if (!page || !hasValidOggCrc(page)) {
        return false;
      }

      const serial = fixed.readUInt32LE(14);
      const sequence = fixed.readUInt32LE(18);
      const bos = (headerType & OGG_BOS) !== 0;
      const eos = (headerType & OGG_EOS) !== 0;
      const continued = (headerType & OGG_CONTINUED) !== 0;
      const prior = streams.get(serial);

      if (!prior) {
        if (!bos || continued || sequence !== 0) {
          return false;
        }
      } else {
        if (prior.ended || bos || sequence !== prior.nextSequence || continued !== prior.continuedPacket) {
          return false;
        }
      }

      const continuesToNextPage = segmentCount > 0 && lacing[segmentCount - 1] === 255;
      if (eos && continuesToNextPage) {
        return false;
      }

      streams.set(serial, {
        nextSequence: (sequence + 1) >>> 0,
        continuedPacket: continuesToNextPage,
        ended: eos,
      });
      sawPayload ||= bodyBytes > 0;
      offset += pageBytes;
      pages += 1;
    }

    return (
      offset === stat.size &&
      pages > 0 &&
      pages < OGG_MAX_PAGES &&
      sawPayload &&
      streams.size > 0 &&
      [...streams.values()].every((stream) => stream.ended && !stream.continuedPacket)
    );
  } finally {
    await handle.close();
  }
}

export async function matchesAacStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 5) {
      return false;
    }

    const prefix = await readExactly(handle, Math.min(4, stat.size), 0);
    if (!prefix) {
      return false;
    }
    if (prefix.equals(AAC_ADIF)) {
      return matchesAdifStructure(handle, stat.size);
    }

    let offset = 0;
    let frames = 0;
    while (offset < stat.size && frames < AAC_MAX_FRAMES) {
      const header = await readExactly(handle, 7, offset);
      if (!header || header[0] !== 0xff || (header[1]! & 0xf0) !== 0xf0 || (header[1]! & 0x06) !== 0) {
        return false;
      }

      const protectionAbsent = (header[1]! & 0x01) !== 0;
      const samplingFrequencyIndex = (header[2]! >> 2) & 0x0f;
      if (samplingFrequencyIndex === 0x0f) {
        return false;
      }

      const headerBytes = protectionAbsent ? 7 : 9;
      const frameBytes = ((header[3]! & 0x03) << 11) | (header[4]! << 3) | (header[5]! >> 5);
      if (frameBytes <= headerBytes || offset + frameBytes > stat.size) {
        return false;
      }
      if (!protectionAbsent && !(await readExactly(handle, 2, offset + 7))) {
        return false;
      }

      offset += frameBytes;
      frames += 1;
    }

    return offset === stat.size && frames > 0 && frames < AAC_MAX_FRAMES;
  } finally {
    await handle.close();
  }
}

export async function matchesMpegAudioStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4) {
      return false;
    }

    let offset = 0;
    const firstThree = await readExactly(handle, Math.min(3, stat.size), 0);
    if (firstThree?.equals(MP3_ID3V2)) {
      const id3Header = await readExactly(handle, 10, 0);
      if (!id3Header) {
        return false;
      }
      const majorVersion = id3Header[3] ?? 0;
      const revision = id3Header[4] ?? 0xff;
      if (majorVersion < 2 || majorVersion > 4 || revision === 0xff) {
        return false;
      }
      const sizeBytes = id3Header.subarray(6, 10);
      if ([...sizeBytes].some((value) => (value & 0x80) !== 0)) {
        return false;
      }
      const tagPayloadBytes =
        (sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!;
      const footerBytes = majorVersion === 4 && (id3Header[5]! & 0x10) !== 0 ? 10 : 0;
      offset = 10 + tagPayloadBytes + footerBytes;
      if (offset > stat.size - 4) {
        return false;
      }
    }

    let audioEnd = stat.size;
    if (audioEnd - offset >= MP3_ID3V1_BYTES) {
      const tag = await readExactly(handle, 3, audioEnd - MP3_ID3V1_BYTES);
      if (tag?.equals(MP3_ID3V1)) {
        audioEnd -= MP3_ID3V1_BYTES;
      }
    }

    let frames = 0;
    while (offset < audioEnd && frames < MP3_MAX_FRAMES) {
      const header = await readExactly(handle, 4, offset);
      if (!header) {
        return false;
      }
      const frameBytes = mpegAudioFrameLength(header);
      if (frameBytes === null || offset + frameBytes > audioEnd) {
        return false;
      }
      offset += frameBytes;
      frames += 1;
    }

    return offset === audioEnd && frames > 0 && frames < MP3_MAX_FRAMES;
  } finally {
    await handle.close();
  }
}

export async function matchesAmrStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= AMR_NB_MAGIC.length) {
      return false;
    }

    const prefix = await readExactly(handle, Math.min(AMR_WB_MAGIC.length, stat.size), 0);
    if (!prefix) {
      return false;
    }

    const wideband = prefix.length >= AMR_WB_MAGIC.length && prefix.subarray(0, AMR_WB_MAGIC.length).equals(AMR_WB_MAGIC);
    const narrowband = prefix.subarray(0, AMR_NB_MAGIC.length).equals(AMR_NB_MAGIC);
    if (!wideband && !narrowband) {
      return false;
    }

    let offset = wideband ? AMR_WB_MAGIC.length : AMR_NB_MAGIC.length;
    let frames = 0;
    while (offset < stat.size && frames < AMR_MAX_FRAMES) {
      const header = await readExactly(handle, 1, offset);
      if (!header || (header[0]! & 0x83) !== 0) {
        return false;
      }
      const frameType = (header[0]! >> 3) & 0x0f;
      const speechBits = amrFrameBits(wideband, frameType);
      if (speechBits === null) {
        return false;
      }
      const payloadBytes = Math.ceil(speechBits / 8);
      if (offset + 1 + payloadBytes > stat.size) {
        return false;
      }

      if (payloadBytes > 0) {
        const lastPayloadByte = await readExactly(handle, 1, offset + payloadBytes);
        if (!lastPayloadByte) {
          return false;
        }
        const paddingBits = payloadBytes * 8 - speechBits;
        if (paddingBits > 0 && (lastPayloadByte[0]! & ((1 << paddingBits) - 1)) !== 0) {
          return false;
        }
      }

      offset += 1 + payloadBytes;
      frames += 1;
    }

    return offset === stat.size && frames > 0 && frames < AMR_MAX_FRAMES;
  } finally {
    await handle.close();
  }
}

async function matchesAdifStructure(
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<boolean> {
  const inspectionBytes = Math.min(fileSize, AAC_ADIF_INSPECTION_BYTES);
  const prefix = await readExactly(handle, inspectionBytes, 0);
  if (!prefix || !prefix.subarray(0, 4).equals(AAC_ADIF)) {
    return false;
  }

  const reader = new BitReader(prefix, 32);
  const copyrightPresent = reader.read(1);
  if (copyrightPresent === null) {
    return false;
  }
  if (copyrightPresent === 1 && reader.read(72) === null) {
    return false;
  }
  if (reader.read(1) === null || reader.read(1) === null) {
    return false;
  }
  const bitstreamType = reader.read(1);
  const bitrate = reader.read(23);
  const numProgramConfigElements = reader.read(4);
  if (bitstreamType === null || bitrate === null || numProgramConfigElements === null) {
    return false;
  }

  const pceCount = numProgramConfigElements + 1;
  for (let index = 0; index < pceCount; index += 1) {
    if (bitstreamType === 0 && reader.read(20) === null) {
      return false;
    }
    if (!parseProgramConfigElement(reader)) {
      return false;
    }
  }

  return reader.byteOffset() < fileSize;
}

function parseProgramConfigElement(reader: BitReader): boolean {
  if (reader.read(4) === null || reader.read(2) === null) {
    return false;
  }
  const samplingFrequencyIndex = reader.read(4);
  const front = reader.read(4);
  const side = reader.read(4);
  const back = reader.read(4);
  const lfe = reader.read(2);
  const assoc = reader.read(3);
  const validCc = reader.read(4);
  if (
    samplingFrequencyIndex === null ||
    samplingFrequencyIndex === 0x0f ||
    front === null ||
    side === null ||
    back === null ||
    lfe === null ||
    assoc === null ||
    validCc === null ||
    front + side + back + lfe === 0
  ) {
    return false;
  }

  const monoMixdown = reader.read(1);
  if (monoMixdown === null || (monoMixdown === 1 && reader.read(4) === null)) {
    return false;
  }
  const stereoMixdown = reader.read(1);
  if (stereoMixdown === null || (stereoMixdown === 1 && reader.read(4) === null)) {
    return false;
  }
  const matrixMixdown = reader.read(1);
  if (matrixMixdown === null || (matrixMixdown === 1 && reader.read(3) === null)) {
    return false;
  }

  for (const count of [front, side, back]) {
    for (let index = 0; index < count; index += 1) {
      if (reader.read(1) === null || reader.read(4) === null) {
        return false;
      }
    }
  }
  for (let index = 0; index < lfe; index += 1) {
    if (reader.read(4) === null) {
      return false;
    }
  }
  for (let index = 0; index < assoc; index += 1) {
    if (reader.read(4) === null) {
      return false;
    }
  }
  for (let index = 0; index < validCc; index += 1) {
    if (reader.read(1) === null || reader.read(4) === null) {
      return false;
    }
  }

  reader.alignToByte();
  const commentBytes = reader.read(8);
  return commentBytes !== null && reader.skip(commentBytes * 8);
}

function mpegAudioFrameLength(header: Buffer): number | null {
  if (header.length < 4 || header[0] !== 0xff || (header[1]! & 0xe0) !== 0xe0) {
    return null;
  }

  const versionBits = (header[1]! >> 3) & 0x03;
  const layerBits = (header[1]! >> 1) & 0x03;
  const bitrateIndex = (header[2]! >> 4) & 0x0f;
  const sampleRateIndex = (header[2]! >> 2) & 0x03;
  const padding = (header[2]! >> 1) & 0x01;
  const emphasis = header[3]! & 0x03;
  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 0x0f ||
    sampleRateIndex === 0x03 ||
    emphasis === 0x02
  ) {
    return null;
  }

  const mpeg1 = versionBits === 3;
  const layer = 4 - layerBits;
  const bitrateKbps = mpegBitrateKbps(mpeg1, layer, bitrateIndex);
  const sampleRateBase = MPEG1_SAMPLE_RATES[sampleRateIndex];
  if (!bitrateKbps || !sampleRateBase) {
    return null;
  }
  const sampleRate = versionBits === 3 ? sampleRateBase : versionBits === 2 ? sampleRateBase / 2 : sampleRateBase / 4;
  const bitrate = bitrateKbps * 1000;

  if (layer === 1) {
    return Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  }
  if (layer === 3 && !mpeg1) {
    return Math.floor((72 * bitrate) / sampleRate) + padding;
  }
  return Math.floor((144 * bitrate) / sampleRate) + padding;
}

function mpegBitrateKbps(mpeg1: boolean, layer: number, index: number): number {
  if (mpeg1) {
    if (layer === 1) {
      return MPEG1_LAYER1_BITRATES[index] ?? 0;
    }
    if (layer === 2) {
      return MPEG1_LAYER2_BITRATES[index] ?? 0;
    }
    return MPEG1_LAYER3_BITRATES[index] ?? 0;
  }
  return layer === 1 ? (MPEG2_LAYER1_BITRATES[index] ?? 0) : (MPEG2_LAYER23_BITRATES[index] ?? 0);
}

function amrFrameBits(wideband: boolean, frameType: number): number | null {
  if (wideband) {
    if (frameType <= 9) {
      return AMR_WB_FRAME_BITS[frameType] ?? null;
    }
    return frameType === 14 || frameType === 15 ? 0 : null;
  }
  if (frameType <= 8) {
    return AMR_NB_FRAME_BITS[frameType] ?? null;
  }
  return frameType === 15 ? 0 : null;
}

function hasValidOggCrc(page: Buffer): boolean {
  if (page.length < OGG_FIXED_HEADER_BYTES) {
    return false;
  }
  const expected = page.readUInt32LE(22);
  let crc = 0;
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index <= 25 ? 0 : page[index]!;
    const tableIndex = ((crc >>> 24) ^ byte) & 0xff;
    crc = (((crc << 8) >>> 0) ^ OGG_CRC_TABLE[tableIndex]!) >>> 0;
  }
  return crc === expected;
}

function buildOggCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = (index << 24) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x80000000) !== 0 ? (((value << 1) >>> 0) ^ 0x04c11db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value;
  }
  return table;
}

class BitReader {
  private bitOffset: number;

  constructor(
    private readonly bytes: Buffer,
    startBitOffset = 0,
  ) {
    this.bitOffset = startBitOffset;
  }

  read(length: number): number | null {
    if (!Number.isInteger(length) || length < 0 || length > 32 || this.bitOffset + length > this.bytes.length * 8) {
      if (length > 32) {
        return this.skip(length) ? 0 : null;
      }
      return null;
    }
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      const absolute = this.bitOffset + index;
      const byte = this.bytes[Math.floor(absolute / 8)]!;
      const bit = (byte >> (7 - (absolute % 8))) & 1;
      value = value * 2 + bit;
    }
    this.bitOffset += length;
    return value;
  }

  skip(length: number): boolean {
    if (!Number.isInteger(length) || length < 0 || this.bitOffset + length > this.bytes.length * 8) {
      return false;
    }
    this.bitOffset += length;
    return true;
  }

  alignToByte(): void {
    const remainder = this.bitOffset % 8;
    if (remainder !== 0) {
      this.bitOffset += 8 - remainder;
    }
  }

  byteOffset(): number {
    return Math.ceil(this.bitOffset / 8);
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer | null> {
  if (length === 0) {
    return Buffer.alloc(0);
  }
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
