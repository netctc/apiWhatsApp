import { open } from "node:fs/promises";
import {
  matchesAudioStructure,
  type StructuredAudioMimeType,
} from "./media-audio-structure.js";
import { matchesJpegStructure, matchesPngStructure } from "./media-image-structure.js";
import {
  matchesIsoBmffFileTypeSignature,
  matchesIsoBmffStructure,
  type IsoBmffMediaMimeType,
} from "./media-isobmff-structure.js";
import { matchesPdfStructure } from "./media-pdf-structure.js";

const INSPECTION_BYTES = 8192;
const PDF_HEADER = Buffer.from("%PDF-", "ascii");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const ZIP_MAX_EOCD_SEARCH_BYTES = ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + ZIP_MAX_COMMENT_BYTES;
const OOXML_MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const OOXML_MAX_ENTRIES = 10_000;
const ZIP16_MAX = 0xffff;
const ZIP32_MAX = 0xffffffff;

const OOXML_REQUIRED_ENTRY_BY_MIME = new Map([
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "word/document.xml",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xl/workbook.xml",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppt/presentation.xml",
  ],
]);
const OOXML_MIME_TYPES = new Set(OOXML_REQUIRED_ENTRY_BY_MIME.keys());
const OOXML_FAMILY_ENTRIES = new Set(OOXML_REQUIRED_ENTRY_BY_MIME.values());
const OOXML_CONTENT_TYPES_ENTRY = "[Content_Types].xml";

const LEGACY_OFFICE_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

interface ZipCentralEntry {
  name: string;
  localHeaderOffset: number;
}

interface ZipEndOfCentralDirectory {
  absoluteOffset: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  totalEntries: number;
}

export class MediaContentSignatureError extends Error {
  constructor(readonly mimeType: string) {
    super(`Media file content does not match declared MIME type: ${mimeType}`);
    this.name = "MediaContentSignatureError";
  }
}

export async function assertMediaContentSignature(filePath: string, mimeType: string): Promise<void> {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  const sample = await readPrefix(filePath);

  if (!matchesMimeSignature(sample, normalizedMimeType)) {
    throw new MediaContentSignatureError(normalizedMimeType);
  }

  if (normalizedMimeType === "image/jpeg") {
    const validImage = await matchesJpegStructure(filePath);
    if (!validImage) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }

  if (normalizedMimeType === "image/png") {
    const validImage = await matchesPngStructure(filePath);
    if (!validImage) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }

  if (isStructuredAudioMimeType(normalizedMimeType)) {
    const validAudio = await matchesAudioStructure(filePath, normalizedMimeType);
    if (!validAudio) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }

  if (normalizedMimeType === "application/pdf") {
    const validDocument = await matchesPdfStructure(filePath);
    if (!validDocument) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }

  if (isIsoBmffMediaMimeType(normalizedMimeType)) {
    const validContainer = await matchesIsoBmffStructure(filePath, normalizedMimeType);
    if (!validContainer) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }

  if (OOXML_MIME_TYPES.has(normalizedMimeType)) {
    const validPackage = await matchesOoxmlPackageIdentity(filePath, normalizedMimeType);
    if (!validPackage) {
      throw new MediaContentSignatureError(normalizedMimeType);
    }
  }
}

export function matchesMimeSignature(sample: Buffer, mimeType: string): boolean {
  if (sample.length === 0) {
    return false;
  }

  switch (mimeType) {
    case "image/jpeg":
      return startsWith(sample, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWithBuffer(sample, PNG_SIGNATURE);
    case "application/pdf":
      return sample.subarray(0, Math.min(sample.length, 1024)).indexOf(PDF_HEADER) >= 0;
    case "audio/ogg":
      return sample.subarray(0, 4).toString("ascii") === "OggS";
    case "audio/aac":
      return isAdtsAac(sample) || sample.subarray(0, 4).toString("ascii") === "ADIF";
    case "audio/mpeg":
      return isMp3(sample);
    case "audio/amr":
      return (
        sample.subarray(0, 6).toString("ascii") === "#!AMR\n" ||
        sample.subarray(0, 9).toString("ascii") === "#!AMR-WB\n"
      );
    case "audio/mp4":
    case "video/mp4":
    case "video/3gpp":
      return matchesIsoBmffFileTypeSignature(sample, mimeType);
    case "text/plain":
      return !sample.includes(0x00);
    default:
      if (LEGACY_OFFICE_MIME_TYPES.has(mimeType)) {
        return startsWithBuffer(sample, OLE_SIGNATURE);
      }
      if (OOXML_MIME_TYPES.has(mimeType)) {
        return startsWithBuffer(sample, ZIP_LOCAL_HEADER);
      }
      return false;
  }
}

function isStructuredAudioMimeType(mimeType: string): mimeType is StructuredAudioMimeType {
  return mimeType === "audio/ogg" || mimeType === "audio/aac" || mimeType === "audio/mpeg" || mimeType === "audio/amr";
}

function isIsoBmffMediaMimeType(mimeType: string): mimeType is IsoBmffMediaMimeType {
  return mimeType === "audio/mp4" || mimeType === "video/mp4" || mimeType === "video/3gpp";
}

async function readPrefix(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(INSPECTION_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function matchesOoxmlPackageIdentity(filePath: string, mimeType: string): Promise<boolean> {
  const expectedFamilyEntry = OOXML_REQUIRED_ENTRY_BY_MIME.get(mimeType);
  if (!expectedFamilyEntry) {
    return false;
  }

  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) {
      return false;
    }

    const tailLength = Math.min(fileStat.size, ZIP_MAX_EOCD_SEARCH_BYTES);
    const tailOffset = fileStat.size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    if (!tail) {
      return false;
    }

    const eocd = parseEndOfCentralDirectory(tail, tailOffset);
    if (!eocd) {
      return false;
    }

    if (
      eocd.totalEntries < 1 ||
      eocd.totalEntries > OOXML_MAX_ENTRIES ||
      eocd.centralDirectorySize < 1 ||
      eocd.centralDirectorySize > OOXML_MAX_CENTRAL_DIRECTORY_BYTES ||
      eocd.centralDirectoryOffset + eocd.centralDirectorySize !== eocd.absoluteOffset
    ) {
      return false;
    }

    const centralDirectory = await readExactly(
      handle,
      eocd.centralDirectorySize,
      eocd.centralDirectoryOffset,
    );
    if (!centralDirectory) {
      return false;
    }

    const entries = parseCentralDirectory(centralDirectory, eocd.totalEntries);
    if (!entries) {
      return false;
    }

    const contentTypes = entries.get(OOXML_CONTENT_TYPES_ENTRY);
    const expectedFamily = entries.get(expectedFamilyEntry);
    if (!contentTypes || !expectedFamily) {
      return false;
    }

    for (const familyEntry of OOXML_FAMILY_ENTRIES) {
      if (familyEntry !== expectedFamilyEntry && entries.has(familyEntry)) {
        return false;
      }
    }

    return (
      (await matchesLocalHeader(handle, contentTypes, eocd.centralDirectoryOffset)) &&
      (await matchesLocalHeader(handle, expectedFamily, eocd.centralDirectoryOffset))
    );
  } finally {
    await handle.close();
  }
}

function parseEndOfCentralDirectory(
  tail: Buffer,
  tailAbsoluteOffset: number,
): ZipEndOfCentralDirectory | null {
  for (let offset = tail.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength !== tail.length) {
      continue;
    }

    const diskNumber = tail.readUInt16LE(offset + 4);
    const centralDirectoryDisk = tail.readUInt16LE(offset + 6);
    const entriesOnDisk = tail.readUInt16LE(offset + 8);
    const totalEntries = tail.readUInt16LE(offset + 10);
    const centralDirectorySize = tail.readUInt32LE(offset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(offset + 16);

    if (
      diskNumber !== 0 ||
      centralDirectoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      entriesOnDisk === ZIP16_MAX ||
      totalEntries === ZIP16_MAX ||
      centralDirectorySize === ZIP32_MAX ||
      centralDirectoryOffset === ZIP32_MAX
    ) {
      return null;
    }

    return {
      absoluteOffset: tailAbsoluteOffset + offset,
      centralDirectoryOffset,
      centralDirectorySize,
      totalEntries,
    };
  }

  return null;
}

function parseCentralDirectory(
  directory: Buffer,
  expectedEntries: number,
): Map<string, ZipCentralEntry> | null {
  const entries = new Map<string, ZipCentralEntry>();
  let offset = 0;

  for (let index = 0; index < expectedEntries; index += 1) {
    if (offset + 46 > directory.length) {
      return null;
    }
    if (directory.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      return null;
    }

    const flags = directory.readUInt16LE(offset + 8);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const fileNameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const diskNumberStart = directory.readUInt16LE(offset + 34);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const recordLength = 46 + fileNameLength + extraLength + commentLength;

    if (
      (flags & 0x0001) !== 0 ||
      compressedSize === ZIP32_MAX ||
      uncompressedSize === ZIP32_MAX ||
      localHeaderOffset === ZIP32_MAX ||
      diskNumberStart !== 0 ||
      fileNameLength === 0 ||
      offset + recordLength > directory.length
    ) {
      return null;
    }

    const fileNameBytes = directory.subarray(offset + 46, offset + 46 + fileNameLength);
    if (fileNameBytes.includes(0x00)) {
      return null;
    }

    const name = fileNameBytes.toString("utf8");
    if (entries.has(name)) {
      return null;
    }

    entries.set(name, { name, localHeaderOffset });
    offset += recordLength;
  }

  return offset === directory.length ? entries : null;
}

async function matchesLocalHeader(
  handle: Awaited<ReturnType<typeof open>>,
  entry: ZipCentralEntry,
  centralDirectoryOffset: number,
): Promise<boolean> {
  if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > centralDirectoryOffset) {
    return false;
  }

  const fixedHeader = await readExactly(handle, 30, entry.localHeaderOffset);
  if (!fixedHeader || fixedHeader.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
    return false;
  }

  const flags = fixedHeader.readUInt16LE(6);
  const fileNameLength = fixedHeader.readUInt16LE(26);
  const extraLength = fixedHeader.readUInt16LE(28);
  const headerEnd = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  if ((flags & 0x0001) !== 0 || fileNameLength === 0 || headerEnd > centralDirectoryOffset) {
    return false;
  }

  const fileNameBytes = await readExactly(handle, fileNameLength, entry.localHeaderOffset + 30);
  if (!fileNameBytes || fileNameBytes.includes(0x00)) {
    return false;
  }

  return fileNameBytes.toString("utf8") === entry.name;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer | null> {
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

function startsWith(sample: Buffer, bytes: number[]): boolean {
  if (sample.length < bytes.length) {
    return false;
  }
  return bytes.every((value, index) => sample[index] === value);
}

function startsWithBuffer(sample: Buffer, signature: Buffer): boolean {
  return sample.length >= signature.length && sample.subarray(0, signature.length).equals(signature);
}

function isAdtsAac(sample: Buffer): boolean {
  if (sample.length < 2) {
    return false;
  }
  return sample[0] === 0xff && (sample[1] & 0xf6) === 0xf0;
}

function isMp3(sample: Buffer): boolean {
  if (sample.length >= 3 && sample.subarray(0, 3).toString("ascii") === "ID3") {
    return true;
  }
  if (sample.length < 2 || sample[0] !== 0xff || (sample[1] & 0xe0) !== 0xe0) {
    return false;
  }
  return (sample[1] & 0x06) !== 0;
}
