import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMediaContentSignature,
  MediaContentSignatureError,
} from "../src/media/media-content-signature.js";

async function withTempFile<T>(bytes: Buffer, operation: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-audio-signature-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  try {
    return await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("audio content signature structural boundary", () => {
  it.each([
    ["audio/ogg", Buffer.from("OggSdata", "ascii")],
    ["audio/aac", Buffer.from([0xff, 0xf1, 0x50, 0x80])],
    ["audio/aac", Buffer.from("ADIFdata", "ascii")],
    ["audio/mpeg", Buffer.from("ID3metadata", "ascii")],
    ["audio/mpeg", Buffer.from([0xff, 0xfb, 0x90, 0x64])],
    ["audio/amr", Buffer.from("#!AMR\nframes", "ascii")],
  ])("rejects prefix-only %s content", async (mimeType, bytes) => {
    await withTempFile(bytes, async (filePath) => {
      await expect(assertMediaContentSignature(filePath, mimeType)).rejects.toBeInstanceOf(
        MediaContentSignatureError,
      );
    });
  });
});
