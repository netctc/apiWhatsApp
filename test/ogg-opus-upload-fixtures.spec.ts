import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesOggStructure } from "../src/media/media-audio-structure.js";
import { assertMediaContentSignature } from "../src/media/media-content-signature.js";
import { invalidOggOpusFixtures, validOggOpus } from "./helpers/ogg-opus-fixtures.js";

async function withFile(bytes: Buffer, run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "api-whatsapp-opus-fixture-"));
  try {
    const path = join(directory, "fixture.ogg");
    await writeFile(path, bytes);
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Ogg Opus HTTP test fixture contracts", () => {
  for (const [name, bytes] of [
    ["minimal mono", validOggOpus()],
    ["64 KiB continued comments", validOggOpus({ tagBytes: 65_536 })],
    ["scanner marker in valid comments", validOggOpus({ vendor: "EICAR_TEST_MARKER" })],
  ] as const) {
    it(`accepts ${name} through the actual content boundary`, async () => {
      await withFile(bytes, async (path) => {
        assert.equal(await matchesOggStructure(path), true);
        await assertMediaContentSignature(path, "audio/ogg");
      });
    });
  }

  for (const fixture of invalidOggOpusFixtures()) {
    it(`rejects ${fixture.name} at the intended structural boundary`, async () => {
      await withFile(fixture.bytes, async (path) => {
        assert.equal(await matchesOggStructure(path), fixture.containerValid);
        await assert.rejects(assertMediaContentSignature(path, "audio/ogg"), {
          name: "MediaContentSignatureError",
          mimeType: "audio/ogg",
        });
      });
    });
  }
});
