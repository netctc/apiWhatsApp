import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesIsoBmffFileTypeSignature,
  matchesIsoBmffStructure,
  type IsoBmffMediaMimeType,
} from "../src/media/media-isobmff-structure.js";

function box(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function extendedBox(type: string, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, "latin1");
  header.writeBigUInt64BE(BigInt(header.length + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function fileTypeBox(majorBrand: string, compatibleBrands: string[] = []): Buffer {
  const payload = Buffer.alloc(8 + compatibleBrands.length * 4);
  payload.write(majorBrand, 0, 4, "latin1");
  payload.writeUInt32BE(0, 4);
  for (const [index, brand] of compatibleBrands.entries()) {
    payload.write(brand, 8 + index * 4, 4, "latin1");
  }
  return box("ftyp", payload);
}

function isoBmffFile(
  mimeType: IsoBmffMediaMimeType,
  options?: {
    majorBrand?: string;
    compatibleBrands?: string[];
    includeMovie?: boolean;
    includeMediaData?: boolean;
    extendedMediaData?: boolean;
    leadingFree?: boolean;
  },
): Buffer {
  const is3gpp = mimeType === "video/3gpp";
  const majorBrand = options?.majorBrand ?? (is3gpp ? "3gp6" : "isom");
  const compatibleBrands =
    options?.compatibleBrands ?? (is3gpp ? ["3gp6", "isom"] : ["iso2", "mp42"]);
  const parts: Buffer[] = [];

  if (options?.leadingFree) {
    parts.push(box("free", Buffer.from("pad", "ascii")));
  }
  parts.push(fileTypeBox(majorBrand, compatibleBrands));
  if (options?.includeMediaData !== false) {
    parts.push(
      options?.extendedMediaData
        ? extendedBox("mdat", Buffer.from("media", "ascii"))
        : box("mdat", Buffer.from("media", "ascii")),
    );
  }
  if (options?.includeMovie !== false) {
    parts.push(box("moov", Buffer.from("movie", "ascii")));
  }

  return Buffer.concat(parts);
}

async function withTempMedia<T>(bytes: Buffer, operation: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-isobmff-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  try {
    return await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("ISO-BMFF media validation", () => {
  it.each(["audio/mp4", "video/mp4"] as const)(
    "recognizes a bounded MP4 ftyp box for %s",
    (mimeType) => {
      const sample = isoBmffFile(mimeType);
      expect(matchesIsoBmffFileTypeSignature(sample, mimeType)).toBe(true);
    },
  );

  it("recognizes registered 3GPP branding", () => {
    const sample = isoBmffFile("video/3gpp");
    expect(matchesIsoBmffFileTypeSignature(sample, "video/3gpp")).toBe(true);
  });

  it("accepts a small fixed-size free box before ftyp", () => {
    const sample = isoBmffFile("video/mp4", { leadingFree: true });
    expect(matchesIsoBmffFileTypeSignature(sample, "video/mp4")).toBe(true);
  });

  it("rejects a raw ftyp string that is not a parsed box", () => {
    const fake = Buffer.from("not-a-box-ftyp-isom", "latin1");
    expect(matchesIsoBmffFileTypeSignature(fake, "video/mp4")).toBe(false);
  });

  it("rejects a malformed ftyp size", () => {
    const malformed = fileTypeBox("isom", ["mp42"]);
    malformed.writeUInt32BE(7, 0);
    expect(matchesIsoBmffFileTypeSignature(malformed, "video/mp4")).toBe(false);
  });

  it("rejects still-image brands when declared as MP4", () => {
    const avif = fileTypeBox("avif", ["mif1"]);
    expect(matchesIsoBmffFileTypeSignature(avif, "video/mp4")).toBe(false);
  });

  it("rejects 3GPP2 branding when declared as 3GPP", () => {
    const threeGpp2 = fileTypeBox("3g2a", ["3g2a"]);
    expect(matchesIsoBmffFileTypeSignature(threeGpp2, "video/3gpp")).toBe(false);
  });

  it("rejects generic MP4 branding when declared as 3GPP", () => {
    const mp4 = fileTypeBox("isom", ["iso2", "mp42"]);
    expect(matchesIsoBmffFileTypeSignature(mp4, "video/3gpp")).toBe(false);
  });

  it.each(["audio/mp4", "video/mp4", "video/3gpp"] as const)(
    "accepts a complete top-level %s container with ftyp, mdat and moov",
    async (mimeType) => {
      await withTempMedia(isoBmffFile(mimeType), async (filePath) => {
        await expect(matchesIsoBmffStructure(filePath, mimeType)).resolves.toBe(true);
      });
    },
  );

  it("skips a bounded extended-size media-data box without loading its body", async () => {
    const media = isoBmffFile("video/mp4", { extendedMediaData: true });
    await withTempMedia(media, async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(true);
    });
  });

  it("rejects an ftyp-only ISO-BMFF file", async () => {
    await withTempMedia(fileTypeBox("isom", ["mp42"]), async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(false);
    });
  });

  it("rejects a container without a movie box", async () => {
    const media = isoBmffFile("video/mp4", { includeMovie: false });
    await withTempMedia(media, async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(false);
    });
  });

  it("rejects a container without media data", async () => {
    const media = isoBmffFile("video/mp4", { includeMediaData: false });
    await withTempMedia(media, async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(false);
    });
  });

  it("rejects top-level boxes whose declared size runs past EOF", async () => {
    const media = isoBmffFile("video/mp4");
    const malformed = Buffer.from(media);
    const ftypSize = malformed.readUInt32BE(0);
    malformed.writeUInt32BE(malformed.length + 1024, ftypSize);

    await withTempMedia(malformed, async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(false);
    });
  });

  it("rejects a second top-level ftyp box", async () => {
    const duplicate = Buffer.concat([
      fileTypeBox("isom", ["mp42"]),
      fileTypeBox("isom", ["mp42"]),
      box("mdat", Buffer.from("media", "ascii")),
      box("moov", Buffer.from("movie", "ascii")),
    ]);

    await withTempMedia(duplicate, async (filePath) => {
      await expect(matchesIsoBmffStructure(filePath, "video/mp4")).resolves.toBe(false);
    });
  });
});
