import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMediaContentSignature,
  MediaContentSignatureError,
} from "../src/media/media-content-signature.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface ZipEntryFixture {
  name: string;
  data?: Buffer;
}

interface TempArchive {
  directory: string;
  filePath: string;
}

function buildStoredZip(entries: ZipEntryFixture[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.from("fixture", "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    localOffsets.push(offset);
    localRecords.push(header, name, data);
    offset += header.length + name.length + data.length;
  }

  const centralDirectoryOffset = offset;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.from("fixture", "utf8");
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localOffsets[index] ?? 0, 42);
    centralRecords.push(header, name);
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

async function writeTempArchive(bytes: Buffer): Promise<TempArchive> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-ooxml-test-"));
  const filePath = join(directory, "upload");
  await writeFile(filePath, bytes);
  return { directory, filePath };
}

async function expectRejected(bytes: Buffer, mimeType: string): Promise<void> {
  const temp = await writeTempArchive(bytes);
  try {
    await expect(assertMediaContentSignature(temp.filePath, mimeType)).rejects.toBeInstanceOf(
      MediaContentSignatureError,
    );
  } finally {
    await rm(temp.directory, { recursive: true, force: true });
  }
}

describe("OOXML package identity validation", () => {
  it.each([
    [DOCX_MIME, "word/document.xml"],
    [XLSX_MIME, "xl/workbook.xml"],
    [PPTX_MIME, "ppt/presentation.xml"],
  ])("accepts a structurally bounded %s package", async (mimeType, familyEntry) => {
    const archive = buildStoredZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8") },
      { name: "_rels/.rels", data: Buffer.from("<Relationships/>", "utf8") },
      { name: familyEntry, data: Buffer.from("<root/>", "utf8") },
    ]);
    const temp = await writeTempArchive(archive);

    try {
      await expect(assertMediaContentSignature(temp.filePath, mimeType)).resolves.toBeUndefined();
    } finally {
      await rm(temp.directory, { recursive: true, force: true });
    }
  });

  it("rejects a PK-prefixed file without a central directory", async () => {
    await expectRejected(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), DOCX_MIME);
  });

  it("rejects a valid OOXML-shaped ZIP declared as the wrong family", async () => {
    const xlsx = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "xl/workbook.xml" },
    ]);

    await expectRejected(xlsx, DOCX_MIME);
  });

  it("rejects a package containing roots for multiple OOXML families", async () => {
    const ambiguous = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
      { name: "xl/workbook.xml" },
    ]);

    await expectRejected(ambiguous, DOCX_MIME);
  });

  it("rejects duplicate central-directory names", async () => {
    const duplicate = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
      { name: "word/document.xml", data: Buffer.from("duplicate", "utf8") },
    ]);

    await expectRejected(duplicate, DOCX_MIME);
  });

  it("rejects a truncated end-of-central-directory record", async () => {
    const archive = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "ppt/presentation.xml" },
    ]);

    await expectRejected(archive.subarray(0, archive.length - 5), PPTX_MIME);
  });

  it("rejects ZIP64 sentinel metadata instead of parsing an unbounded extension", async () => {
    const archive = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
    ]);
    const zip64Sentinel = Buffer.from(archive);
    const eocdOffset = zip64Sentinel.length - 22;
    zip64Sentinel.writeUInt16LE(0xffff, eocdOffset + 8);
    zip64Sentinel.writeUInt16LE(0xffff, eocdOffset + 10);

    await expectRejected(zip64Sentinel, DOCX_MIME);
  });

  it("rejects a central entry whose required local header points outside file data", async () => {
    const archive = buildStoredZip([
      { name: "[Content_Types].xml" },
      { name: "word/document.xml" },
    ]);
    const invalidLocalOffset = Buffer.from(archive);
    const eocdOffset = invalidLocalOffset.length - 22;
    const centralOffset = invalidLocalOffset.readUInt32LE(eocdOffset + 16);
    const firstNameLength = invalidLocalOffset.readUInt16LE(centralOffset + 28);
    const firstExtraLength = invalidLocalOffset.readUInt16LE(centralOffset + 30);
    const firstCommentLength = invalidLocalOffset.readUInt16LE(centralOffset + 32);
    const secondCentralHeader =
      centralOffset + 46 + firstNameLength + firstExtraLength + firstCommentLength;
    invalidLocalOffset.writeUInt32LE(centralOffset, secondCentralHeader + 42);

    await expectRejected(invalidLocalOffset, DOCX_MIME);
  });
});
