import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const prismaRequire = createRequire(require.resolve("prisma/config"));
const configRequire = createRequire(prismaRequire.resolve("@prisma/config"));

async function versionFromEntry(entry, name) {
  let directory = dirname(entry);
  while (directory !== parse(directory).root) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === name) return pkg.version;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  assert.fail(`Unable to identify the installed ${name} package`);
}

test("Prisma ancestors resolve the reviewed patched transitive packages", async () => {
  assert.equal(await versionFromEntry(prismaRequire.resolve("@prisma/config"), "@prisma/config"), "7.10.0");
  assert.equal(await versionFromEntry(configRequire.resolve("deepmerge-ts"), "deepmerge-ts"), "8.0.1");
  assert.equal(await versionFromEntry(prismaRequire.resolve("mysql2"), "mysql2"), "3.23.1");
  assert.equal(typeof prismaRequire("mysql2").createConnection, "function");
});

test("patched deepmerge preserves plain Prisma configuration merging without input mutation", () => {
  const { deepmerge } = configRequire("deepmerge-ts");
  const defaults = { datasource: { url: "postgresql://localhost/example" }, migrations: { path: "migrations" } };
  const overrides = { datasource: { shadowDatabaseUrl: "postgresql://localhost/shadow" }, schema: "schema.prisma" };
  const beforeDefaults = structuredClone(defaults);
  const beforeOverrides = structuredClone(overrides);
  assert.deepEqual(deepmerge(defaults, overrides), {
    datasource: { url: "postgresql://localhost/example", shadowDatabaseUrl: "postgresql://localhost/shadow" },
    migrations: { path: "migrations" }, schema: "schema.prisma",
  });
  assert.deepEqual(defaults, beforeDefaults);
  assert.deepEqual(overrides, beforeOverrides);
});

test("Prisma loads an actual configuration through its patched c12 merger", async () => {
  const { loadConfigFromFile } = prismaRequire("@prisma/config");
  const directory = await mkdtemp(join(tmpdir(), "prisma-dependency-compatibility-"));
  try {
    const file = join(directory, "prisma.config.mjs");
    await writeFile(file, 'export default { schema: "schema.prisma", migrations: { path: "migrations" }, datasource: { url: "postgresql://localhost/example" } };\n');
    const loaded = await loadConfigFromFile({ configFile: file, configRoot: directory });
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.resolvedPath, file);
    assert.equal(loaded.config.schema, join(directory, "schema.prisma"));
    assert.equal(loaded.config.migrations.path, join(directory, "migrations"));
    assert.equal(loaded.config.datasource.url, "postgresql://localhost/example");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
