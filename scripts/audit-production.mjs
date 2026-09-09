import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["audit", "--omit=dev", "--omit=peer", "--json"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(`Unable to execute npm audit: ${result.error.message}`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("npm audit did not return a valid JSON report");
  if (result.stderr) {
    console.error(result.stderr.trim());
  }
  process.exit(2);
}

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const blocked = [];
const lockfileOnly = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  const severity = vulnerability?.severity ?? "info";
  if ((severityRank[severity] ?? 0) < severityRank.high) {
    continue;
  }

  const installedNodes = (vulnerability.nodes ?? []).filter((node) =>
    existsSync(resolve(process.cwd(), node)),
  );

  const finding = {
    name,
    severity,
    installedNodes,
  };
  if (installedNodes.length > 0) {
    blocked.push(finding);
  } else {
    lockfileOnly.push(finding);
  }
}

console.log(
  `Runtime audit inspected ${report.metadata?.dependencies?.prod ?? "unknown"} production dependencies.`,
);
if (lockfileOnly.length > 0) {
  console.log(
    `Ignored ${lockfileOnly.length} high/critical lockfile advisory entries because their affected packages are not installed in the production runtime tree: ${lockfileOnly
      .map((finding) => finding.name)
      .join(", ")}`,
  );
}

if (blocked.length > 0) {
  console.error("High/critical vulnerabilities are present in the installed production runtime tree:");
  for (const finding of blocked) {
    console.error(`- ${finding.name}: ${finding.severity} (${finding.installedNodes.join(", ")})`);
  }
  process.exit(1);
}

console.log("Production runtime audit passed: no installed high/critical vulnerabilities detected.");
