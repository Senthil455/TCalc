export { scanWorkspace, walkFiles, resolveIgnoreRules } from "./scanWorkspace.js";
export type { ScanOptions } from "./scanWorkspace.js";
export { classifyFile, detectSecretRisk } from "./classifyFile.js";
export { IgnoreResolver } from "./ignoreResolver.js";
export type { IgnoreResult, IgnoreResolverOptions } from "./ignoreResolver.js";

export {
  parseGitStatusPorcelain,
  summarizeGitStatus,
  filterFilesByGitStatus,
  createGitStatusFilterPredicate,
  resolveGitStatus,
} from "./gitStatusResolver.js";

export type {
  GitFileStatus,
  GitFileStatusCode,
  GitFilterScope,
  GitStatusFilterOptions,
  GitStatusPredicateOptions,
  GitStatusSummary,
} from "./types/gitFilter.js";
