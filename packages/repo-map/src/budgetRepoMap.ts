import type { RepoMapFile, RepoMapResult } from "@wma/core";
import { estimateTokens } from "@wma/tokenizers";
import { formatRepoMapMarkdown } from "./formatRepoMapMarkdown.js";

export function budgetRepoMap(repoMap: RepoMapResult, tokenBudget: number): RepoMapResult {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new RangeError(`tokenBudget must be a finite number > 0 (got ${tokenBudget})`);
  }
  const result: RepoMapResult = {
    ...repoMap,
    importantFiles: [...repoMap.importantFiles],
    testFiles: [...repoMap.testFiles],
    largeFiles: [...repoMap.largeFiles],
    riskyFiles: [...repoMap.riskyFiles],
    generatedFiles: [...repoMap.generatedFiles],
    excludedFiles: [...repoMap.excludedFiles],
    recommendedInclude: [...repoMap.recommendedInclude],
    recommendedExclude: [...repoMap.recommendedExclude],
    overflowNotes: [...repoMap.overflowNotes],
  };

  updateSerializedEstimate(result);
  if (result.estimatedTokens <= tokenBudget) return result;

  const highPriorityPaths = new Set([
    ...repoMap.entryPoints,
    ...repoMap.configFiles,
    ...repoMap.documentationFiles,
  ].map((file) => file.relativePath));

  const candidates = uniqueTrimCandidates(repoMap, highPriorityPaths);
  result.overflowNotes.push(`Budget of ${tokenBudget.toLocaleString()} tokens exceeded; lower-priority sections were trimmed.`);

  let trimmedCount = 0;
  for (const file of candidates) {
    if (result.estimatedTokens <= tokenBudget) break;
    removeEverywhere(result, file.relativePath);
    trimmedCount++;
    refreshSummary(result);
    refreshAgentInstructions(result);
    updateSerializedEstimate(result);
  }

  if (trimmedCount > 0) {
    result.overflowNotes.push(`Trimmed ${trimmedCount} lower-priority file(s); entry points, config, and documentation were preserved.`);
    refreshSymbolSummary(result);
    refreshSummary(result);
    refreshAgentInstructions(result);
  }

  updateSerializedEstimate(result);
  if (result.estimatedTokens > tokenBudget) {
    result.overflowNotes.push(`The required high-priority sections need ${result.estimatedTokens.toLocaleString()} tokens and cannot fit the requested budget.`);
    updateSerializedEstimate(result);
  }

  return result;
}

function uniqueTrimCandidates(repoMap: RepoMapResult, highPriorityPaths: Set<string>): RepoMapFile[] {
  const ordered = [
    ...repoMap.largeFiles,
    ...repoMap.generatedFiles,
    ...repoMap.riskyFiles,
    ...repoMap.excludedFiles,
    ...repoMap.testFiles,
    ...repoMap.importantFiles,
  ];
  const seen = new Set<string>();
  return ordered.filter((file) => {
    if (highPriorityPaths.has(file.relativePath) || seen.has(file.relativePath)) return false;
    seen.add(file.relativePath);
    return true;
  });
}

function removeEverywhere(repoMap: RepoMapResult, relativePath: string): void {
  repoMap.importantFiles = withoutPath(repoMap.importantFiles, relativePath);
  repoMap.testFiles = withoutPath(repoMap.testFiles, relativePath);
  repoMap.largeFiles = withoutPath(repoMap.largeFiles, relativePath);
  repoMap.riskyFiles = withoutPath(repoMap.riskyFiles, relativePath);
  repoMap.generatedFiles = withoutPath(repoMap.generatedFiles, relativePath);
  repoMap.excludedFiles = withoutPath(repoMap.excludedFiles, relativePath);
  repoMap.recommendedInclude = withoutPath(repoMap.recommendedInclude, relativePath);
  repoMap.recommendedExclude = withoutPath(repoMap.recommendedExclude, relativePath);
  repoMap.symbols = repoMap.symbols.filter((symbol) => symbol.relativePath !== relativePath);
  repoMap.imports = repoMap.imports.filter((entry) => entry.relativePath !== relativePath);
  repoMap.routes = repoMap.routes.filter((route) => route.relativePath !== relativePath);
}

function refreshSymbolSummary(repoMap: RepoMapResult): void {
  repoMap.symbolSummary = repoMap.symbols.length === 0 ? [] : [
    `${repoMap.symbols.length} symbols extracted from ${new Set(repoMap.symbols.map((symbol) => symbol.relativePath)).size} files`,
    `Exports: ${repoMap.symbols.filter((symbol) => symbol.exported).length}`,
    `Functions: ${repoMap.symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "component").length}`,
    `Classes: ${repoMap.symbols.filter((symbol) => symbol.kind === "class").length}`,
    `Interfaces/Types: ${repoMap.symbols.filter((symbol) => symbol.kind === "interface" || symbol.kind === "type").length}`,
    `Routes: ${repoMap.routes.length}`,
  ];
}

function refreshSummary(repoMap: RepoMapResult): void {
  const importantTokens = repoMap.importantFiles.reduce(
    (sum, file) => sum + file.estimatedTokens,
    0,
  );
  const derivedLines: Array<[string, string]> = [
    ["Important files identified:", `Important files identified: ${repoMap.importantFiles.length}`],
    ["Entry points:", `Entry points: ${repoMap.entryPoints.length}`],
    ["Tests:", `Tests: ${repoMap.testFiles.length}`],
    ["Config files:", `Config files: ${repoMap.configFiles.length}`],
    ["Documentation files:", `Documentation files: ${repoMap.documentationFiles.length}`],
    ["Large files:", `Large files: ${repoMap.largeFiles.length}`],
    ["Risky files:", `Risky files: ${repoMap.riskyFiles.length}`],
    ["Tokens in important files:", `Tokens in important files: ~${importantTokens.toLocaleString()}`],
  ];

  const replaced = new Set<string>();
  const lines = repoMap.summary.split("\n").map((line) => {
    const match = derivedLines.find(([prefix]) => line.startsWith(prefix));
    if (!match) return line;
    replaced.add(match[0]);
    return match[1];
  });

  for (const [prefix, line] of derivedLines) {
    if (!replaced.has(prefix)) lines.push(line);
  }

  repoMap.summary = lines.join("\n");
}

function refreshAgentInstructions(repoMap: RepoMapResult): void {
  const updated: string[] = [];

  for (const instruction of repoMap.agentInstructions) {
    if (instruction.startsWith("Key entry points to read first:")) {
      if (repoMap.entryPoints.length > 0) {
        const entryPoints = repoMap.entryPoints
          .slice(0, 5)
          .map((file) => file.relativePath)
          .join(", ");
        updated.push(`Key entry points to read first: ${entryPoints}`);
      }
      continue;
    }

    if (instruction.startsWith("There are ") && instruction.includes("large file(s)")) {
      if (repoMap.largeFiles.length > 0) {
        updated.push(`There are ${repoMap.largeFiles.length} large file(s). Ask before reading them.`);
      }
      continue;
    }

    if (instruction.startsWith("There are ") && instruction.includes("sensitive file(s)")) {
      if (repoMap.riskyFiles.length > 0) {
        updated.push(`There are ${repoMap.riskyFiles.length} potentially sensitive file(s). Ask before reading.`);
      }
      continue;
    }

    if (instruction.startsWith("There are ") && instruction.includes("generated file(s)")) {
      if (repoMap.generatedFiles.length > 0) {
        updated.push(`There are ${repoMap.generatedFiles.length} generated file(s). Avoid editing them.`);
      }
      continue;
    }

    updated.push(instruction);
  }

  repoMap.agentInstructions = updated;
}

function withoutPath(files: RepoMapFile[], relativePath: string): RepoMapFile[] {
  return files.filter((file) => file.relativePath !== relativePath);
}

function updateSerializedEstimate(repoMap: RepoMapResult): void {
  let estimate = estimateTokens(formatRepoMapMarkdown(repoMap));
  repoMap.estimatedTokens = estimate;
  const stableEstimate = estimateTokens(formatRepoMapMarkdown(repoMap));
  if (stableEstimate !== estimate) {
    estimate = stableEstimate;
    repoMap.estimatedTokens = estimate;
  }
}
