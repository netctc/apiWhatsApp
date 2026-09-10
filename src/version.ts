import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) {
  throw new Error("package.json must define a semantic x.y.z version");
}

export const APP_VERSION = packageMetadata.version;
export const APP_USER_AGENT = `apiWhatsApp/${APP_VERSION}`;
