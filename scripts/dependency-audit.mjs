import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const NODE = /^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/i;
const VERSION = /^[0-9][0-9a-z.+-]{0,127}$/i;
const RANGE = /^[0-9a-z*^~<>=|.+ ()-]{1,300}$/i;
const GHSA = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/i;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class AuditEvidenceError extends Error {}

function requireValid(condition, message) {
  if (!condition) throw new AuditEvidenceError(message);
}

function validateLockfile(lockfile) {
  requireValid(object(lockfile) && [2, 3].includes(lockfile.lockfileVersion) &&
    object(lockfile.packages) && object(lockfile.packages[""]), "Invalid dependency lockfile");
}

function validateReport(result) {
  requireValid(!result.error && !result.signal && [0, 1].includes(result.status),
    "npm audit did not complete successfully");
  requireValid(typeof result.stdout === "string" &&
    Buffer.byteLength(result.stdout) <= MAX_REPORT_BYTES, "Invalid audit output size");
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new AuditEvidenceError("npm audit did not return valid JSON"); }
  requireValid(object(report) && !has(report, "error") && report.auditReportVersion === 2 &&
    object(report.vulnerabilities) && object(report.metadata) &&
    object(report.metadata.vulnerabilities), "Incomplete or unsupported npm audit report");
  const counts = report.metadata.vulnerabilities;
  for (const key of [...Object.keys(RANK), "total"]) {
    requireValid(Number.isSafeInteger(counts[key]) && counts[key] >= 0,
      "Invalid audit vulnerability counts");
  }
  const entries = Object.entries(report.vulnerabilities);
  requireValid(counts.total === entries.length &&
    Object.keys(RANK).reduce((sum, key) => sum + counts[key], 0) === counts.total,
    "Inconsistent audit vulnerability counts");
  requireValid(result.status === (counts.high + counts.critical > 0 ? 1 : 0),
    "Audit exit status contradicts vulnerability counts");
  return report;
}

/** Pure policy evaluation; no raw npm errors, URLs, titles or credentials are returned. */
export function evaluateAuditResult(result, { mode, lockfile, isInstalled }) {
  requireValid(mode === "runtime" || mode === "full", "Unknown dependency audit mode");
  validateLockfile(lockfile);
  const report = validateReport(result);
  const observed = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const blocked = [];
  const omitted = [];
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    requireValid(NAME.test(name) && object(finding) && finding.name === name &&
      has(RANK, finding.severity) && typeof finding.range === "string" && RANGE.test(finding.range) &&
      Array.isArray(finding.nodes) && finding.nodes.length > 0 &&
      Array.isArray(finding.via) && Array.isArray(finding.effects), "Invalid audit finding");
    observed[finding.severity] += 1;
    const nodes = finding.nodes.map((path) => {
      requireValid(typeof path === "string" && NODE.test(path) &&
        !path.split("/").some((part) => part === "." || part === "..") &&
        has(lockfile.packages, path), "Audit node is outside the locked dependency tree");
      const entry = lockfile.packages[path];
      requireValid(object(entry) && typeof entry.version === "string" && VERSION.test(entry.version),
        "Invalid locked dependency version");
      return {
        path, version: entry.version, installed: Boolean(isInstalled(path)),
        dev: entry.dev === true, optional: entry.optional === true, peer: entry.peer === true,
      };
    });
    const via = finding.via.map((cause) => {
      if (typeof cause === "string") {
        requireValid(NAME.test(cause) && has(report.vulnerabilities, cause),
          "Invalid transitive audit finding");
        return { dependency: cause };
      }
      requireValid(object(cause) && typeof cause.name === "string" && NAME.test(cause.name) &&
        has(RANK, cause.severity), "Invalid audit advisory");
      return { dependency: cause.name, severity: cause.severity,
        advisory: typeof cause.url === "string" ? GHSA.exec(cause.url)?.[1] ?? null : null };
    });
    requireValid(finding.effects.every((name) => typeof name === "string" && NAME.test(name)),
      "Invalid audit dependency effects");
    let fixAvailable = finding.fixAvailable === true;
    if (object(finding.fixAvailable)) {
      const fix = finding.fixAvailable;
      requireValid(typeof fix.name === "string" && NAME.test(fix.name) &&
        typeof fix.version === "string" && VERSION.test(fix.version) &&
        typeof fix.isSemVerMajor === "boolean", "Invalid audit remediation");
      fixAvailable = { name: fix.name, version: fix.version, isSemVerMajor: fix.isSemVerMajor };
    } else {
      requireValid(typeof finding.fixAvailable === "boolean", "Invalid audit remediation");
    }
    if (RANK[finding.severity] < RANK.high) continue;
    const evidence = { name, severity: finding.severity, range: finding.range,
      nodes, via, effects: finding.effects, fixAvailable };
    (mode === "full" || nodes.some((node) => node.installed) ? blocked : omitted).push(evidence);
  }
  for (const key of Object.keys(RANK)) {
    requireValid(observed[key] === report.metadata.vulnerabilities[key],
      "Audit severity counts contradict findings");
  }
  return { mode, counts: { ...observed, total: Object.values(observed).reduce((a, b) => a + b, 0) },
    blocked, omitted };
}

/** Exit codes: 0 passed, 1 high/critical findings, 2 unavailable or malformed evidence. */
export function runDependencyAudit(mode, {
  cwd = process.cwd(), execute = spawnSync, log = console.log, error = console.error,
} = {}) {
  try {
    requireValid(mode === "runtime" || mode === "full", "Unknown dependency audit mode");
    let lockfile;
    let installedLock;
    try {
      lockfile = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
      installedLock = JSON.parse(readFileSync(resolve(cwd, "node_modules/.package-lock.json"), "utf8"));
    } catch { throw new AuditEvidenceError("A locked npm installation is required before auditing"); }
    validateLockfile(lockfile);
    requireValid(object(installedLock) && object(installedLock.packages) &&
      Object.keys(installedLock.packages).length > 0, "Installed dependency tree is missing");
    const isInstalled = (path) => existsSync(resolve(cwd, path, "package.json"));
    for (const name of Object.keys(lockfile.packages[""].dependencies ?? {})) {
      requireValid(NAME.test(name) && isInstalled(`node_modules/${name}`),
        "A direct production dependency is missing from the installation");
    }
    const args = ["audit", "--json", "--audit-level=high", "--ignore-scripts",
      ...(mode === "runtime" ? ["--omit=dev", "--omit=peer"] :
        ["--include=dev", "--include=peer", "--include=optional"])];
    const result = execute(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd, encoding: "utf8", maxBuffer: MAX_REPORT_BYTES,
      timeout: TIMEOUT_MS, killSignal: "SIGKILL",
    });
    const evidence = evaluateAuditResult(result, { mode, lockfile, isInstalled });
    log(JSON.stringify({ auditMode: mode, counts: evidence.counts }));
    for (const finding of evidence.blocked) log(JSON.stringify({ blocked: finding }));
    for (const finding of evidence.omitted) log(JSON.stringify({ notInstalled: finding }));
    if (evidence.blocked.length > 0) {
      error(`Dependency audit blocked: ${evidence.blocked.length} high/critical ${mode} findings.`);
      return 1;
    }
    log(`Dependency audit passed: no ${mode === "runtime" ? "installed " : ""}high/critical findings.`);
    return 0;
  } catch (failure) {
    // Only bounded, locally defined messages escape. npm stderr may contain registry credentials.
    const message = failure instanceof AuditEvidenceError
      ? failure.message : "Unable to verify dependency audit evidence";
    error(`Dependency audit unavailable: ${message}`);
    return 2;
  }
}
