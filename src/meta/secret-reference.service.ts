import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Injectable } from "@nestjs/common";

const DEFAULT_SECRET_FILE_ROOTS = "/run/secrets/api-whatsapp";
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export type SecretReferenceErrorReason =
  | "INVALID_REFERENCE"
  | "NOT_CONFIGURED"
  | "UNAVAILABLE"
  | "INVALID_SECRET";

export class SecretReferenceError extends Error {
  constructor(
    readonly reason: SecretReferenceErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "SecretReferenceError";
  }
}

@Injectable()
export class SecretReferenceService {
  async resolve(reference: string): Promise<string> {
    if (reference.startsWith("env:")) {
      return this.resolveEnvironment(reference.slice(4));
    }
    if (reference.startsWith("file:")) {
      return this.resolveFile(reference.slice(5));
    }

    throw new SecretReferenceError(
      "INVALID_REFERENCE",
      "Secret reference must use env: or file:",
    );
  }

  private resolveEnvironment(name: string): string {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SecretReferenceError(
        "INVALID_REFERENCE",
        "Environment secret references must use a valid environment variable name",
      );
    }

    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new SecretReferenceError("NOT_CONFIGURED", "Referenced environment secret is unavailable");
    }
    return this.validateSecretValue(value);
  }

  private async resolveFile(rawPath: string): Promise<string> {
    if (!rawPath || !isAbsolute(rawPath)) {
      throw new SecretReferenceError(
        "INVALID_REFERENCE",
        "Mounted secret reference must contain an absolute path",
      );
    }

    const allowedRoots = this.allowedFileRoots();
    let resolvedPath: string;
    try {
      resolvedPath = await realpath(rawPath);
    } catch {
      throw new SecretReferenceError("UNAVAILABLE", "Mounted secret file is unavailable");
    }

    const allowed = await this.isInsideAllowedRoot(resolvedPath, allowedRoots);
    if (!allowed) {
      throw new SecretReferenceError(
        "INVALID_REFERENCE",
        "Mounted secret path is outside the configured secret roots",
      );
    }

    let fileHandle;
    try {
      const linkStat = await lstat(resolvedPath);
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
        throw new SecretReferenceError("INVALID_SECRET", "Mounted secret must be a regular file");
      }
      if (linkStat.size <= 0 || linkStat.size > MAX_SECRET_FILE_BYTES) {
        throw new SecretReferenceError(
          "INVALID_SECRET",
          `Mounted secret file must contain between 1 and ${MAX_SECRET_FILE_BYTES} bytes`,
        );
      }

      fileHandle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const handleStat = await fileHandle.stat();
      if (!handleStat.isFile() || handleStat.size <= 0 || handleStat.size > MAX_SECRET_FILE_BYTES) {
        throw new SecretReferenceError("INVALID_SECRET", "Mounted secret file is invalid");
      }

      const value = await fileHandle.readFile({ encoding: "utf8" });
      return this.validateSecretValue(value.replace(/[\r\n]+$/, ""));
    } catch (error) {
      if (error instanceof SecretReferenceError) {
        throw error;
      }
      throw new SecretReferenceError("UNAVAILABLE", "Mounted secret file is unavailable");
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }

  private allowedFileRoots(): string[] {
    const raw = process.env.SECRET_FILE_ROOTS ?? DEFAULT_SECRET_FILE_ROOTS;
    const roots = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (roots.length === 0) {
      throw new SecretReferenceError("NOT_CONFIGURED", "No mounted secret roots are configured");
    }

    return roots.map((root) => {
      if (!isAbsolute(root)) {
        throw new SecretReferenceError(
          "NOT_CONFIGURED",
          "Mounted secret roots must be absolute paths",
        );
      }
      const normalized = resolve(root);
      if (normalized === sep) {
        throw new SecretReferenceError(
          "NOT_CONFIGURED",
          "Filesystem root cannot be used as a mounted secret root",
        );
      }
      return normalized;
    });
  }

  private async isInsideAllowedRoot(path: string, roots: string[]): Promise<boolean> {
    for (const root of roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        continue;
      }
      if (path === realRoot || path.startsWith(`${realRoot}${sep}`)) {
        return true;
      }
    }
    return false;
  }

  private validateSecretValue(value: string): string {
    if (value.length === 0 || value.length > MAX_SECRET_FILE_BYTES) {
      throw new SecretReferenceError("INVALID_SECRET", "Secret value has an invalid length");
    }
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new SecretReferenceError("INVALID_SECRET", "Secret value must be a single-line string");
    }
    return value;
  }
}
