import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findApprovalRecord, writeApprovalRecord } from "./approval_queue.js";

const [, , action, id, reasonArg] = process.argv;

if (!action || !id || !["approve", "reject"].includes(action)) {
  console.error("Usage: node set-approval-status.js <approve|reject> <id> [reason]");
  process.exit(1);
}

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const reason = reasonArg || "Rejected by owner";

try {
  const entry = await findApprovalRecord(baseDir, id);
  if (!entry) {
    throw new Error(`Approval not found: ${id}`);
  }

  if (entry.status === "completed" || entry.status === "failed" || entry.status === "rejected") {
    console.log(`Approval already finalized: ${id} (${entry.status})`);
    process.exit(0);
  }

  const record = { ...entry.record };
  const now = new Date().toISOString();

  if (action === "approve") {
    record.status = "approved";
    record.updatedAt = now;
    record.approvedAt = now;
    await writeApprovalRecord(baseDir, "approved", record);
    await cleanupSource(entry.filePath);
    console.log(`Approved: ${id}`);
    process.exit(0);
  }

  record.status = "rejected";
  record.updatedAt = now;
  record.rejectedAt = now;
  record.errorText = reason;
  await writeApprovalRecord(baseDir, "rejected", record);
  await cleanupSource(entry.filePath);
  console.log(`Rejected: ${id}`);
  process.exit(0);
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}

async function cleanupSource(filePath) {
  try {
    await fs.rm(filePath, { force: true });
  } catch {
    // ignore stale pending files
  }
}
