import fs from "node:fs/promises";
import path from "node:path";

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "running",
  "completed",
  "rejected",
  "failed",
];

export function getApprovalsRoot(baseDir) {
  return path.join(baseDir, "approvals");
}

export function getApprovalStatusDir(baseDir, status) {
  return path.join(getApprovalsRoot(baseDir), status);
}

export function getApprovalFilePath(baseDir, status, id) {
  return path.join(getApprovalStatusDir(baseDir, status), `${id}.json`);
}

export async function ensureApprovalDirectories(baseDir) {
  await Promise.all(
    APPROVAL_STATUSES.map((status) =>
      fs.mkdir(getApprovalStatusDir(baseDir, status), { recursive: true }),
    ),
  );
}

export async function writeApprovalRecord(baseDir, status, record) {
  const targetPath = getApprovalFilePath(baseDir, status, record.id);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await writeJsonAtomic(targetPath, record);
  return targetPath;
}

export async function readApprovalRecord(baseDir, status, id) {
  const targetPath = getApprovalFilePath(baseDir, status, id);
  const raw = await fs.readFile(targetPath, "utf8");
  return parseApprovalJson(raw);
}

export async function tryReadApprovalRecord(baseDir, status, id) {
  try {
    return await readApprovalRecord(baseDir, status, id);
  } catch {
    return null;
  }
}

export async function findApprovalRecord(baseDir, id) {
  for (const status of APPROVAL_STATUSES) {
    const filePath = getApprovalFilePath(baseDir, status, id);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return {
        status,
        filePath,
        record: parseApprovalJson(raw),
      };
    } catch {
      // keep searching
    }
  }
  return null;
}

export async function listApprovalRecords(baseDir, status) {
  const dir = getApprovalStatusDir(baseDir, status);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      records.push(parseApprovalJson(raw));
    } catch {
      // ignore malformed or half-written files
    }
  }

  records.sort((left, right) => {
    const leftTime = Date.parse(left?.updatedAt ?? left?.createdAt ?? "1970-01-01") || 0;
    const rightTime = Date.parse(right?.updatedAt ?? right?.createdAt ?? "1970-01-01") || 0;
    return leftTime - rightTime;
  });
  return records;
}

export async function moveApprovalRecord(baseDir, id, fromStatus, toStatus, mutate) {
  const fromPath = getApprovalFilePath(baseDir, fromStatus, id);
  const toPath = getApprovalFilePath(baseDir, toStatus, id);
  const raw = await fs.readFile(fromPath, "utf8");
  const record = parseApprovalJson(raw);
  const nextRecord =
    typeof mutate === "function" ? await mutate(record) : record;
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await writeJsonAtomic(toPath, nextRecord);
  await fs.rm(fromPath, { force: true });
  return nextRecord;
}

export async function updateApprovalRecord(baseDir, status, id, mutate) {
  const filePath = getApprovalFilePath(baseDir, status, id);
  const raw = await fs.readFile(filePath, "utf8");
  const record = parseApprovalJson(raw);
  const nextRecord =
    typeof mutate === "function" ? await mutate(record) : record;
  await writeJsonAtomic(filePath, nextRecord);
  return nextRecord;
}

async function writeJsonAtomic(targetPath, payload) {
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  const serialized = JSON.stringify(payload, null, 2);
  await fs.writeFile(tempPath, serialized, "utf8");
  try {
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
    await fs.writeFile(targetPath, serialized, "utf8");
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // ignore temp cleanup failures on locked Windows files
    }
  }
}

function parseApprovalJson(raw) {
  return JSON.parse(String(raw).replace(/^\uFEFF/, ""));
}
