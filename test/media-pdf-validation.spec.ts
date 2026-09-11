import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesPdfStructure } from "../src/media/media-pdf-structure.js";

function buildClassicPdf(options?: {
  header?: string;
  xrefOffsetOverride?: number;
  trailing?: string;
}): Buffer {
  const prefix = Buffer.from(
    `${options?.header ?? "%PDF-1.7\n"}1 0 obj\n<< /Type /Catalog >>\nendobj\n`,
    "latin1",
  );
  const xrefOffset = options?.xrefOffsetOverride ?? prefix.length;
  const suffix = Buffer.from(
    `xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF${options?.trailing ?? "\n"}`,
    "latin1",
  );
  return Buffer.concat([prefix, suffix]);
}

function buildXrefStreamPdf(): Buffer {
  const prefix = Buffer.from("%PDF-2.0\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1");
  const xrefOffset = prefix.length;
  const suffix = Buffer.from(
    `2 0 obj\n<< /Type /XRef /Size 3 >>\nstream\nxref-data\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\r\n`,
    "latin1",
  );
  return Buffer.concat([prefix, suffix]);
}

async function withTempPdf<T>(bytes: Buffer, operation: (filePath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-pdf-test-"));
  const filePath = join(directory, "upload.pdf");
  await writeFile(filePath, bytes);

  try {
    return await operation(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("matchesPdfStructure", () => {
  it("accepts a classic xref table with a final bounded startxref section", async () => {
    await withTempPdf(buildClassicPdf(), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(true);
    });
  });

  it("accepts an xref stream target represented by an indirect object", async () => {
    await withTempPdf(buildXrefStreamPdf(), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(true);
    });
  });

  it("accepts leading bytes before a versioned PDF header within the first KiB", async () => {
    const pdf = buildClassicPdf({ header: `leading-comment\n%PDF-1.6\n` });

    await withTempPdf(pdf, async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(true);
    });
  });

  it("rejects a PDF-like prefix without a final startxref and EOF section", async () => {
    await withTempPdf(Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "latin1"), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects an invalid PDF version header", async () => {
    await withTempPdf(buildClassicPdf({ header: "%PDF-not-a-version\n" }), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects startxref offsets that do not point to xref data", async () => {
    await withTempPdf(buildClassicPdf({ xrefOffsetOverride: 0 }), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects startxref offsets outside the file", async () => {
    await withTempPdf(buildClassicPdf({ xrefOffsetOverride: 9_999_999 }), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(false);
    });
  });

  it("rejects non-whitespace bytes after the final EOF marker", async () => {
    await withTempPdf(buildClassicPdf({ trailing: "\nPK\u0003\u0004" }), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(false);
    });
  });

  it("accepts PDF whitespace after the final EOF marker", async () => {
    await withTempPdf(buildClassicPdf({ trailing: "\r\n\t\f\u0000 " }), async (filePath) => {
      await expect(matchesPdfStructure(filePath)).resolves.toBe(true);
    });
  });
});
