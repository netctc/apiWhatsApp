/**
 * Bounded Ogg Opus upload profile. Feed only pages that have already passed the
 * Ogg framing, CRC, sequence and continuation checks in media-audio-structure.
 * This validates headers and packet framing, not compressed audio samples.
 */
const OPUS_HEAD = Buffer.from("OpusHead", "ascii");
const OPUS_TAGS = Buffer.from("OpusTags", "ascii");
const MAX_TAG_BYTES = 64 * 1024;
const MAX_AUDIO_PACKET_BYTES = 61_440;
const MAX_AUDIO_PACKETS = 100_000;
const MAX_FRAME_BYTES = 1275;

export class OggOpusProfile {
  private serial: number | undefined;
  private phase: "head" | "tags" | "audio" = "head";
  private readonly packet = Buffer.alloc(MAX_TAG_BYTES);
  private packetBytes = 0;
  private audioPackets = 0;
  private ended = false;

  acceptPage(page: Buffer): boolean {
    if (this.ended || page.length < 27) {
      return false;
    }
    const segmentCount = page[26]!;
    if (page.length < 27 + segmentCount) {
      return false;
    }
    const serial = page.readUInt32LE(14);
    if (this.serial !== undefined && serial !== this.serial) {
      return false; // No chained or multiplexed streams in this upload profile.
    }
    this.serial = serial;
    const flags = page[5]!;
    const granule = page.readBigInt64LE(6);
    const lacing = page.subarray(27, 27 + segmentCount);
    const body = page.subarray(27 + segmentCount);
    if (lacing.reduce((sum, length) => sum + length, 0) !== body.length) {
      return false;
    }

    if (this.phase === "head") {
      // Version 1, mapping family 0, one output channel, one complete ID packet.
      if (
        flags !== 0x02 || granule !== 0n || segmentCount !== 1 || lacing[0] !== 19 ||
        !body.subarray(0, 8).equals(OPUS_HEAD) || body[8] !== 1 ||
        body[9] !== 1 || body[18] !== 0
      ) {
        return false;
      }
      this.phase = "tags";
      return true;
    }

    if (segmentCount === 0) {
      return false; // Empty pages are outside this deliberately strict profile.
    }
    let bodyOffset = 0;
    let completedOnPage = false;
    for (let index = 0; index < lacing.length; index += 1) {
      const length = lacing[index]!;
      const limit = this.phase === "tags" ? MAX_TAG_BYTES : MAX_AUDIO_PACKET_BYTES;
      if (this.packetBytes + length > limit) {
        return false;
      }
      body.copy(this.packet, this.packetBytes, bodyOffset, bodyOffset + length);
      this.packetBytes += length;
      bodyOffset += length;
      if (length === 255) {
        continue;
      }

      const packet = this.packet.subarray(0, this.packetBytes);
      if (this.phase === "tags") {
        if (index !== lacing.length - 1 || granule !== 0n || !matchesOpusTags(packet)) {
          return false;
        }
        this.phase = "audio";
      } else {
        if (this.audioPackets >= MAX_AUDIO_PACKETS || !matchesOpusPacketFraming(packet)) {
          return false;
        }
        this.audioPackets += 1;
      }
      this.packetBytes = 0;
      completedOnPage = true;
    }

    if ((!completedOnPage && granule !== -1n) || (completedOnPage && granule < 0n)) {
      return false;
    }
    this.ended = (flags & 0x04) !== 0;
    return !this.ended || this.isComplete();
  }

  isComplete(): boolean {
    return this.ended && this.phase === "audio" && this.audioPackets > 0 && this.packetBytes === 0;
  }
}

function matchesOpusTags(packet: Buffer): boolean {
  if (packet.length < 16 || !packet.subarray(0, 8).equals(OPUS_TAGS)) {
    return false;
  }
  const vendorLength = packet.readUInt32LE(8);
  if (vendorLength > packet.length - 16) {
    return false;
  }
  let offset = 12 + vendorLength;
  const count = packet.readUInt32LE(offset);
  offset += 4;
  if (count > Math.floor((packet.length - offset) / 4)) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    if (offset > packet.length - 4) {
      return false;
    }
    const length = packet.readUInt32LE(offset);
    offset += 4;
    if (length > packet.length - offset) {
      return false;
    }
    offset += length;
  }
  // RFC 7845 permits padding/unspecified binary data after the comment list.
  // Metadata text is neither decoded nor logged by this identity boundary.
  return true;
}

/** RFC 6716 section 3 framing, including legal zero-byte PLC/DTX frames. */
export function matchesOpusPacketFraming(packet: Buffer): boolean {
  if (packet.length === 0 || packet.length > MAX_AUDIO_PACKET_BYTES) {
    return false;
  }
  const toc = packet[0]!;
  const code = toc & 3;
  const config = toc >> 3;
  const samplesPerFrame = config >= 16
    ? 120 * (2 ** (config & 3))
    : config >= 12
      ? 480 * (2 ** (config & 1))
      : (config & 3) === 3 ? 2880 : 480 * (2 ** (config & 3));

  if (code === 0) {
    return packet.length - 1 <= MAX_FRAME_BYTES;
  }
  if (code === 1) {
    return (packet.length - 1) % 2 === 0 && (packet.length - 1) / 2 <= MAX_FRAME_BYTES;
  }

  let offset = 1;
  let end = packet.length;
  let frames = 2;
  if (code === 3) {
    if (offset >= end) {
      return false;
    }
    const control = packet[offset++]!;
    frames = control & 0x3f;
    if (frames === 0 || samplesPerFrame * frames > 5760) {
      return false;
    }
    if ((control & 0x40) !== 0) {
      let paddingByte: number;
      do {
        if (offset >= end) {
          return false;
        }
        paddingByte = packet[offset++]!;
        end -= paddingByte === 255 ? 254 : paddingByte;
        if (offset > end) {
          return false;
        }
      } while (paddingByte === 255);
    }
    if ((control & 0x80) === 0) {
      const frameBytes = (end - offset) / frames;
      return Number.isInteger(frameBytes) && frameBytes <= MAX_FRAME_BYTES;
    }
  }

  let declaredBytes = 0;
  for (let index = 0; index < frames - 1; index += 1) {
    if (offset >= end) {
      return false;
    }
    let length = packet[offset++]!;
    if (length >= 252) {
      if (offset >= end) {
        return false;
      }
      length += 4 * packet[offset++]!;
    }
    declaredBytes += length;
    if (declaredBytes > end - offset) {
      return false;
    }
  }
  const lastFrameBytes = end - offset - declaredBytes;
  return lastFrameBytes >= 0 && lastFrameBytes <= MAX_FRAME_BYTES;
}
