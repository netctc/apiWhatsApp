import { runDependencyAudit } from "./dependency-audit.mjs";

process.exitCode = runDependencyAudit("full");
