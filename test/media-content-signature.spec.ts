import { matchesMimeSignature } from "../src/media/media-content-signature.js";

function fileTypeBox(majorBrand: string, compatibleBrands: string[]): Buffer {
  const box = Buffer.alloc(16 + compatibleBrands.length * 4);
  box.writeUInt32BE(box.length, 0);
  box.write("ftyp", 4, 4, "latin1");
  box.write(majorBrand, 8, 4, "latin1");
  box.writeUInt32BE(0, 12);
  for (const [index, brand] of compatibleBrands.entries()) {
    box.write(brand, 16 + index * 4, 4, "latin1");
  }
  return box;
}

describe("matchesMimeSignature", () => {
  it("recognizes image and PDF signatures", () => {
    expect(matchesMimeSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(
      matchesMimeSignature(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png",
      ),
    ).toBe(true);
    expect(matchesMimeSignature(Buffer.from("\n%PDF-1.7\n", "ascii"), "application/pdf")).toBe(true);
  });

  it("recognizes supported audio signatures", () => {
    expect(matchesMimeSignature(Buffer.from("OggSdata", "ascii"), "audio/ogg")).toBe(true);
    expect(matchesMimeSignature(Buffer.from([0xff, 0xf1, 0x50, 0x80]), "audio/aac")).toBe(true);
    expect(matchesMimeSignature(Buffer.from("ADIFdata", "ascii"), "audio/aac")).toBe(true);
    expect(matchesMimeSignature(Buffer.from("ID3metadata", "ascii"), "audio/mpeg")).toBe(true);
    expect(matchesMimeSignature(Buffer.from([0xff, 0xfb, 0x90, 0x64]), "audio/mpeg")).toBe(true);
    expect(matchesMimeSignature(Buffer.from("#!AMR\nframes", "ascii"), "audio/amr")).toBe(true);
  });

  it("recognizes structured ISO-BMFF and 3GPP file-type boxes", () => {
    const mp4 = fileTypeBox("isom", ["iso2", "mp42"]);
    const threeGp = fileTypeBox("3gp6", ["3gp6", "isom"]);

    expect(matchesMimeSignature(mp4, "audio/mp4")).toBe(true);
    expect(matchesMimeSignature(mp4, "video/mp4")).toBe(true);
    expect(matchesMimeSignature(threeGp, "video/3gpp")).toBe(true);
    expect(matchesMimeSignature(mp4, "video/3gpp")).toBe(false);
  });

  it("recognizes legacy Office and OOXML containers", () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

    expect(matchesMimeSignature(ole, "application/msword")).toBe(true);
    expect(matchesMimeSignature(ole, "application/vnd.ms-excel")).toBe(true);
    expect(matchesMimeSignature(ole, "application/vnd.ms-powerpoint")).toBe(true);
    expect(
      matchesMimeSignature(
        zip,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(
      matchesMimeSignature(
        zip,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
    expect(
      matchesMimeSignature(
        zip,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe(true);
  });

  it("accepts basic text samples but rejects NUL-containing binary data", () => {
    expect(matchesMimeSignature(Buffer.from("plain text\n", "utf8"), "text/plain")).toBe(true);
    expect(matchesMimeSignature(Buffer.from([0x70, 0x00, 0x71]), "text/plain")).toBe(false);
  });

  it("rejects mismatched or unknown signatures", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    expect(matchesMimeSignature(png, "image/jpeg")).toBe(false);
    expect(matchesMimeSignature(Buffer.from("not a pdf", "ascii"), "application/pdf")).toBe(false);
    expect(matchesMimeSignature(Buffer.from("anything", "ascii"), "application/octet-stream")).toBe(false);
    expect(matchesMimeSignature(Buffer.alloc(0), "image/jpeg")).toBe(false);
  });
});
