export type GitFileStatusCode =
  | "M" // Modified
  | "A" // Added
  | "D" // Deleted
  | "R" // Renamed
  | "C" // Copied
  | "U" // Updated but unmerged (conflict)
  | "?" // Untracked
  | "!" // Ignored
  | " "; // Unmodified in this area

export interface GitFileStatus {
  path: string;
  originalPath?: string;
  indexStatus: GitFileStatusCode;
  worktreeStatus: GitFileStatusCode;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
  isConflicted: boolean;
  isDeleted: boolean;
}

export type GitFilterScope = "staged" | "unstaged" | "all-dirty" | "untracked" | "conflicted";

export interface GitStatusFilterOptions {
  cwd?: string;
  scope?: GitFilterScope;
  includeDeleted?: boolean;
  gitExecutable?: string;
}

export interface GitStatusPredicateOptions {
  /**
   * Fold path case during matching. Defaults to false on case-sensitive
   * platforms (Linux) and true on case-insensitive platforms (Windows and
   * macOS). Callers that know the repository setting can override it.
   */
  caseSensitive?: boolean;
}

export interface GitStatusSummary {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  conflictedFiles: string[];
  deletedFiles: string[];
  totalDirtyCount: number;
  entries: GitFileStatus[];
}
