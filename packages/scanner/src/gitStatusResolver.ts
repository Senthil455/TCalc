import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type {
  GitFileStatus,
  GitFileStatusCode,
  GitFilterScope,
  GitStatusFilterOptions,
  GitStatusSummary,
} from "./types/gitFilter.js";

const execFileAsync = promisify(execFile);

function normalizeGitPath(raw: string): string {
  // Git always emits forward slashes, but normalize defensively for callers
  // that hand us captured output from another platform.
  return raw.replace(/\\/g, "/");
}

function cleanLegacyPath(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  return normalizeGitPath(cleaned);
}

function buildGitFileStatus(
  indexStatus: GitFileStatusCode,
  worktreeStatus: GitFileStatusCode,
  filePath: string,
  originalPath?: string,
): GitFileStatus {
  const isUntracked = indexStatus === "?" && worktreeStatus === "?";
  const isConflicted =
    (indexStatus === "U" || worktreeStatus === "U") ||
    (indexStatus === "A" && worktreeStatus === "A") ||
    (indexStatus === "D" && worktreeStatus === "D");
  const isStaged = !isUntracked && !isConflicted && indexStatus !== " " && indexStatus !== "?";
  const isUnstaged = !isUntracked && !isConflicted && worktreeStatus !== " " && worktreeStatus !== "?";
  const isDeleted = indexStatus === "D" || worktreeStatus === "D";

  return {
    path: filePath,
    originalPath,
    indexStatus,
    worktreeStatus,
    isStaged,
    isUnstaged,
    isUntracked,
    isConflicted,
    isDeleted,
  };
}

function isRenameOrCopy(status: GitFileStatusCode): boolean {
  return status === "R" || status === "C";
}

function parseNulDelimitedGitStatus(output: string): GitFileStatus[] {
  const records = output.split("\0");
  const results: GitFileStatus[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record || record.length < 3) {
      continue;
    }

    const indexStatus = record[0] as GitFileStatusCode;
    const worktreeStatus = record[1] as GitFileStatusCode;
    const rawPath = record.substring(3);

    if (!rawPath) {
      continue;
    }

    let originalPath: string | undefined;

    if (isRenameOrCopy(indexStatus) || isRenameOrCopy(worktreeStatus)) {
      // In -z mode a rename or copy emits the destination path followed by a
      // second NUL-terminated field for the source path. There is no quoting
      // and no " -> " separator, so names containing the arrow stay intact.
      const source = records[index + 1];
      if (source === undefined) {
        continue;
      }
      originalPath = normalizeGitPath(source);
      index++;
    }

    results.push(
      buildGitFileStatus(
        indexStatus,
        worktreeStatus,
        normalizeGitPath(rawPath),
        originalPath,
      ),
    );
  }

  return results;
}

function parseLegacyNewlineGitStatus(output: string): GitFileStatus[] {
  const lines = output.split(/\r?\n/);
  const results: GitFileStatus[] = [];

  for (const line of lines) {
    if (!line || line.length < 3) {
      continue;
    }

    const indexStatus = line[0] as GitFileStatusCode;
    const worktreeStatus = line[1] as GitFileStatusCode;
    const rawPath = line.substring(3).trim();

    if (!rawPath) {
      continue;
    }

    let filePath = rawPath;
    let originalPath: string | undefined;

    if (rawPath.includes(" -> ")) {
      const parts = rawPath.split(" -> ");
      originalPath = cleanLegacyPath(parts[0]);
      filePath = cleanLegacyPath(parts[1]);
    } else {
      filePath = cleanLegacyPath(rawPath);
    }

    results.push(
      buildGitFileStatus(indexStatus, worktreeStatus, filePath, originalPath),
    );
  }

  return results;
}

export function parseGitStatusPorcelain(output: string): GitFileStatus[] {
  if (!output) {
    return [];
  }

  if (output.includes("\0")) {
    return parseNulDelimitedGitStatus(output);
  }

  if (!output.trim()) {
    return [];
  }

  return parseLegacyNewlineGitStatus(output);
}

export function summarizeGitStatus(entries: GitFileStatus[]): GitStatusSummary {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const conflictedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isDeleted) {
      deletedFiles.push(entry.path);
    }
    if (entry.isStaged) {
      stagedFiles.push(entry.path);
    }
    if (entry.isUnstaged) {
      unstagedFiles.push(entry.path);
    }
    if (entry.isUntracked) {
      untrackedFiles.push(entry.path);
    }
    if (entry.isConflicted) {
      conflictedFiles.push(entry.path);
    }
  }

  return {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    conflictedFiles,
    deletedFiles,
    totalDirtyCount: entries.length,
    entries,
  };
}

export function filterFilesByGitStatus(
  entries: GitFileStatus[],
  scope: GitFilterScope = "all-dirty",
  includeDeleted = false,
): string[] {
  const filtered = entries.filter((entry) => {
    if (!includeDeleted && entry.isDeleted) {
      return false;
    }

    switch (scope) {
      case "staged":
        return entry.isStaged;
      case "unstaged":
        return entry.isUnstaged;
      case "untracked":
        return entry.isUntracked;
      case "conflicted":
        return entry.isConflicted;
      case "all-dirty":
      default:
        return entry.isStaged || entry.isUnstaged || entry.isUntracked || entry.isConflicted;
    }
  });

  return filtered.map((e) => e.path);
}

export function createGitStatusFilterPredicate(
  entries: GitFileStatus[],
  scope: GitFilterScope = "all-dirty",
  workspaceRoot?: string,
): (candidatePath: string) => boolean {
  const matchingPaths = new Set(
    filterFilesByGitStatus(entries, scope, false).map((p) => p.replace(/\\/g, "/").toLowerCase()),
  );

  return (candidatePath: string): boolean => {
    let normalized = candidatePath.replace(/\\/g, "/");
    if (workspaceRoot) {
      const rel = path.relative(workspaceRoot, candidatePath).replace(/\\/g, "/");
      normalized = rel;
    }
    normalized = normalized.toLowerCase();

    if (!normalized) {
      return false;
    }

    // Check direct path match or suffix match
    if (matchingPaths.has(normalized)) {
      return true;
    }

    // Suffixes must start at a path segment so "src/a.ts" does not match "src/data.ts".
    for (const target of matchingPaths) {
      if (normalized.endsWith(`/${target}`) || target.endsWith(`/${normalized}`)) {
        return true;
      }
    }

    return false;
  };
}

export async function resolveGitStatus(
  options: GitStatusFilterOptions = {},
): Promise<GitStatusSummary> {
  const cwd = options.cwd ?? process.cwd();
  const gitExec = options.gitExecutable ?? "git";

  try {
    const { stdout } = await execFileAsync(gitExec, ["status", "--porcelain=v1", "-z", "-uall"], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    const entries = parseGitStatusPorcelain(stdout);
    return summarizeGitStatus(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve git status in directory "${cwd}": ${message}`);
  }
}
