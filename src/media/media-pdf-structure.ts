import { open } from "node:fs/promises";

const PDF_HEADER_SEARCH_BYTES = 1024;
const PDF_TAIL_SEARCH_BYTES = 64 * 1024;
const PDF_XREF_TARGET_BYTES = 128;
const PDF_VERSION_HEADER = /^%PDF-(?:1\.[0-9]|2\.0)(?:\r\n|\r|\n)/;
const PDF_FINAL_SECTION = /startxref\s+([0-9]+)\s+%%EOF/g;
const PDF_XREF_TABLE = /^xref\s/;
const PDF_XREF_STREAM_OBJECT = /^[0-9]+\s+[0-9]+\s+obj(?:\s|<)/;
const PDF_WHITESPACE_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export async function matchesPdfStructure(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 20) {
      return false;
    }

    const prefixLength = Math.min(fileStat.size, PDF_HEADER_SEARCH_BYTES);
    const prefix = await readExactly(handle, prefixLength, 0);
    if (!prefix || !hasVersionedHeader(prefix)) {
      return false;
    }

    const tailLength = Math.min(fileStat.size, PDF_TAIL_SEARCH_BYTES);
    const tailOffset = fileStat.size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    if (!tail) {
      return false;
    }

    const finalSection = findFinalSection(tail);
    if (!finalSection) {
      return false;
    }

    if (
      !Number.isSafeInteger(finalSection.xrefOffset) ||
      finalSection.xrefOffset < 0 ||
      finalSection.xrefOffset >= fileStat.size
    ) {
      return false;
    }

    const targetLength = Math.min(PDF_XREF_TARGET_BYTES, fileStat.size - finalSection.xrefOffset);
    const xrefTarget = await readExactly(handle, targetLength, finalSection.xrefOffset);
    if (!xrefTarget) {
      return false;
    }

    const targetText = xrefTarget.toString("latin1").replaceAll("\u0000", " ");
    return PDF_XREF_TABLE.test(targetText) || PDF_XREF_STREAM_OBJECT.test(targetText);
  } finally {
    await handle.close();
  }
}

function hasVersionedHeader(prefix: Buffer): boolean {
  const text = prefix.toString("latin1");
  const headerOffset = text.indexOf("%PDF-");
  if (headerOffset < 0) {
    return false;
  }

  return PDF_VERSION_HEADER.test(text.slice(headerOffset));
}

function findFinalSection(tail: Buffer): { xrefOffset: number } | null {
  const text = tail.toString("latin1").replaceAll("\u0000", " ");
  let accepted: { xrefOffset: number } | null = null;

  PDF_FINAL_SECTION.lastIndex = 0;
  for (let match = PDF_FINAL_SECTION.exec(text); match; match = PDF_FINAL_SECTION.exec(text)) {
    const trailing = tail.subarray(match.index + match[0].length);
    if (!isPdfWhitespace(trailing)) {
      continue;
    }

    const xrefOffsetText = match[1];
    if (!xrefOffsetText) {
      continue;
    }

    const xrefOffset = Number.parseInt(xrefOffsetText, 10);
    accepted = { xrefOffset };
  }

  return accepted;
}

function isPdfWhitespace(bytes: Buffer): boolean {
  for (const value of bytes) {
    if (!PDF_WHITESPACE_BYTES.has(value)) {
      return false;
    }
  }
  return true;
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
