import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAuditResult, runDependencyAudit } from "../dependency-audit.mjs";

const lockfile = { lockfileVersion: 3, packages: {
  "": { dependencies: { example: "1.0.0" } },
  "node_modules/example": { version: "1.0.0", dev: true },
  "node_modules/example/node_modules/@scope/child": { version: "2.0.0" },
} };
const finding = (severity = "high") => ({
  name: "example", severity, range: "<1.0.1", nodes: ["node_modules/example"],
  via: [{ name: "example", severity, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
  effects: [], fixAvailable: { name: "example", version: "1.0.1", isSemVerMajor: false },
});
function report(severity) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  if (severity) { counts[severity] = 1; counts.total = 1; }
  return { auditReportVersion: 2, vulnerabilities: severity ? { example: finding(severity) } : {},
    metadata: { vulnerabilities: counts } };
}
function result(value = report()) {
  return { status: value?.metadata?.vulnerabilities?.high + value?.metadata?.vulnerabilities?.critical > 0 ? 1 : 0,
    stdout: JSON.stringify(value), stderr: "", signal: null };
}
function evaluate(value, mode = "runtime", installed = true) {
  return evaluateAuditResult(value, { mode, lockfile, isInstalled: () => installed });
}

test("accepts a complete clean audit report", () => {
  assert.deepEqual(evaluate(result()).blocked, []);
});
for (const severity of ["high", "critical"]) {
  test(`blocks installed ${severity} runtime dependencies`, () => {
    const evidence = evaluate(result(report(severity)));
    assert.equal(evidence.blocked.length, 1);
    assert.equal(evidence.blocked[0].nodes[0].version, "1.0.0");
    assert.equal(evidence.blocked[0].via[0].advisory, "GHSA-aaaa-bbbb-cccc");
  });
  test(`runtime distinguishes omitted ${severity} nodes from installed ones`, () => {
    const evidence = evaluate(result(report(severity)), "runtime", false);
    assert.equal(evidence.blocked.length, 0);
    assert.equal(evidence.omitted.length, 1);
  });
  test(`full mode blocks ${severity} lockfile findings even when omitted locally`, () => {
    assert.equal(evaluate(result(report(severity)), "full", false).blocked.length, 1);
  });
}
for (const severity of ["info", "low", "moderate"]) {
  test(`reports ${severity} counts without blocking at the high threshold`, () => {
    const evidence = evaluate(result(report(severity)), "full");
    assert.equal(evidence.counts[severity], 1);
    assert.equal(evidence.blocked.length, 0);
  });
}
for (const [name, value] of [
  ["npm error JSON", { ...result(), status: 1, stdout: JSON.stringify({ error: { code: "E503" } }) }],
  ["empty object", result({})], ["null", result(null)], ["array", result([])],
  ["non-JSON", { ...result(), stdout: "service unavailable" }],
  ["empty stdout", { ...result(), stdout: "" }],
  ["spawn failure", { ...result(), error: new Error("private-registry-token") }],
  ["signal termination", { ...result(), signal: "SIGTERM" }],
  ["missing exit status", { ...result(), status: null }],
  ["unsupported exit status", { ...result(), status: 127 }],
  ["nonzero exit with no findings", { ...result(), status: 1 }],
  ["zero exit with high findings", { ...result(report("high")), status: 0 }],
  ["future schema", result({ ...report(), auditReportVersion: 3 })],
  ["missing findings", result({ ...report(), vulnerabilities: undefined })],
  ["missing metadata", result({ ...report(), metadata: undefined })],
  ["error alongside valid report", result({ ...report(), error: { code: "EAUDIT" } })],
]) {
  test(`fails closed on ${name}`, () => assert.throws(() => evaluate(value)));
}
for (const [name, mutate] of [
  ["unknown severity", (r) => { r.vulnerabilities.example.severity = "unexpected"; }],
  ["missing affected nodes", (r) => { r.vulnerabilities.example.nodes = []; }],
  ["missing causes", (r) => { delete r.vulnerabilities.example.via; }],
  ["missing remediation", (r) => { delete r.vulnerabilities.example.fixAvailable; }],
  ["negative count", (r) => { r.metadata.vulnerabilities.low = -1; }],
  ["mismatched total", (r) => { r.metadata.vulnerabilities.total = 0; }],
  ["mismatched severities", (r) => { r.metadata.vulnerabilities.high = 0; r.metadata.vulnerabilities.critical = 1; }],
  ["unknown transitive cause", (r) => { r.vulnerabilities.example.via = ["missing"]; }],
]) {
  test(`rejects ${name}`, () => {
    const value = report("high"); mutate(value);
    assert.throws(() => evaluate(result(value)));
  });
}
for (const path of ["../outside", "/node_modules/example", "node_modules/../example", "node_modules/missing", "node_modules/example\\..\\other"]) {
  test(`rejects an untrusted dependency node ${path}`, () => {
    const value = report("high"); value.vulnerabilities.example.nodes = [path];
    assert.throws(() => evaluate(result(value)));
  });
}
test("retains safe nested scoped dependency paths", () => {
  const value = report("high");
  value.vulnerabilities.example.nodes = ["node_modules/example/node_modules/@scope/child"];
  assert.equal(evaluate(result(value)).blocked[0].nodes[0].version, "2.0.0");
});
test("does not expose titles, raw errors, or credential-bearing advisory URLs", () => {
  const value = report("high");
  value.vulnerabilities.example.via[0].url = "https://secret@example.org/?token=secret";
  value.vulnerabilities.example.via[0].title = "secret";
  assert.ok(!JSON.stringify(evaluate(result(value))).includes("secret"));
});
test("rejects unknown audit modes and invalid lockfiles", () => {
  assert.throws(() => evaluate(result(), "other"));
  assert.throws(() => evaluateAuditResult(result(), { mode: "full", lockfile: {}, isInstalled: () => true }));
});

function withInstallation(run) {
  const cwd = mkdtempSync(join(tmpdir(), "dependency-audit-test-"));
  try {
    mkdirSync(join(cwd, "node_modules/example"), { recursive: true });
    writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lockfile));
    writeFileSync(join(cwd, "node_modules/.package-lock.json"), JSON.stringify(lockfile));
    writeFileSync(join(cwd, "node_modules/example/package.json"), "{}");
    const lines = [];
    return run({ cwd, log: (line) => lines.push(line), error: (line) => lines.push(line) }, lines);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
test("runner explicitly includes the full tree and bounds execution resources", () => {
  withInstallation((options) => {
    const code = runDependencyAudit("full", { ...options, execute: (_command, args, config) => {
      for (const arg of ["--json", "--audit-level=high", "--ignore-scripts", "--include=dev", "--include=peer", "--include=optional"]) {
        assert.ok(args.includes(arg));
      }
      assert.equal(config.timeout, 120_000);
      assert.equal(config.killSignal, "SIGKILL");
      assert.equal(config.maxBuffer, 16 * 1024 * 1024);
      return result();
    } });
    assert.equal(code, 0);
  });
});
test("runtime runner keeps production omission policy", () => {
  withInstallation((options) => {
    assert.equal(runDependencyAudit("runtime", { ...options, execute: (_command, args) => {
      assert.ok(args.includes("--omit=dev")); assert.ok(args.includes("--omit=peer"));
      return result(report("high"));
    } }), 1);
  });
});
test("missing installation is an infrastructure failure, not a clean audit", () => {
  withInstallation((options, lines) => {
    rmSync(join(options.cwd, "node_modules"), { recursive: true });
    assert.equal(runDependencyAudit("runtime", { ...options, execute: () => assert.fail("must not execute npm") }), 2);
    assert.ok(!lines.some((line) => line.includes("audit passed")));
  });
});
test("missing direct production dependency cannot be ignored as omitted", () => {
  withInstallation((options) => {
    rmSync(join(options.cwd, "node_modules/example"), { recursive: true });
    assert.equal(runDependencyAudit("runtime", { ...options, execute: () => assert.fail("must not execute npm") }), 2);
  });
});
for (const [name, execute] of [
  ["registry error", () => ({ status: 1, stdout: '{"error":{"summary":"secret"}}', stderr: "secret" })],
  ["timeout", () => ({ status: null, signal: "SIGKILL", error: new Error("secret") })],
  ["unexpected exception", () => { throw new Error("npm audit secret"); }],
]) {
  test(`runner fails closed without leaking ${name}`, () => {
    withInstallation((options, lines) => {
      assert.equal(runDependencyAudit("runtime", { ...options, execute }), 2);
      assert.ok(!lines.join("\n").includes("secret"));
      assert.ok(!lines.join("\n").includes("audit passed"));
    });
  });
}
