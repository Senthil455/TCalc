import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanWorkspace, resolveGitStatus, createGitStatusFilterPredicate } from "@wma/scanner";
import { loadModelCatalog, queryModelCatalog, validateModelCatalog } from "@wma/model-catalog";
import { recommendModels } from "@wma/recommender";
import {
  analyzeTokenDrift,
  formatDriftMarkdown,
  generateJsonReport,
  generateMarkdownReport,
} from "@wma/reports";
import { createRepoMap, formatRepoMapMarkdown, progressiveCompact } from "@wma/repo-map";
import { executeCatalogValidate } from "../../src/commands/catalog.js";
import { handleEstimateFilesTokens } from "../../../../packages/mcp-server/src/tools/estimateFilesTokensTool.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cross-module workspace pipeline", () => {
  it("scans once and keeps reports and repo-map context consistent", async () => {
    const root = await tempDirectory("tcalc-integration-scan-");
    await writeWorkspaceFixture(root);

    const scan = await scanWorkspace({ rootPath: root });
    const files = new Map(scan.files.map((file) => [file.relativePath, file]));

    expect(files.get("db/schema.sql")?.included).toBe(true);
    expect(files.get("src/generated/skip.ts")?.included).toBe(false);
    expect(files.get("src/generated/skip.ts")?.excludedReason).toContain("ignore");
    expect(files.get("assets/vendor.min.js")?.riskFlags).toContain("generated");
    expect(files.get(".env")?.riskFlags).toContain("secret");
    expect(files.get("src/secret.ts")?.riskFlags).toContain("secret");
    expect(files.get("src/secret.ts")?.included).toBe(false);

    const includedTokens = scan.files
      .filter((file) => file.included)
      .reduce((total, file) => total + file.estimatedTokens, 0);
    expect(scan.includedTokens).toBe(includedTokens);
    expect(scan.includedFiles).toBe(scan.files.filter((file) => file.included).length);

    const json = JSON.parse(generateJsonReport(scan, null));
    expect(json.summary).toMatchObject({
      totalFiles: scan.totalFiles,
      includedFiles: scan.includedFiles,
      excludedFiles: scan.excludedFiles,
      totalEstimatedTokens: scan.totalEstimatedTokens,
      includedTokens: scan.includedTokens,
    });
    expect(json.topTokenConsumers.map((entry: { path: string }) => entry.path)).not.toContain("src/secret.ts");
    expect(json.topFolders.map((entry: { path: string }) => entry.path)).not.toContain("assets");

    const markdown = generateMarkdownReport(scan, null);
    expect(markdown).toContain("| Included Tokens |");
    expect(markdown).toContain("db/schema.sql");
    expect(markdown).toContain("src/secret.ts");

    const repoMap = createRepoMap(scan, { tokenBudget: 100_000 });
    const includedPaths = new Set(scan.files.filter((file) => file.included).map((file) => file.relativePath));
    expect(repoMap.importantFiles.every((file) => includedPaths.has(file.relativePath))).toBe(true);
    expect(repoMap.entryPoints.map((file) => file.relativePath)).toContain("src/index.ts");
    expect(repoMap.summary).toContain(`Files: ${scan.includedFiles} included`);
    const srcFolder = scan.folders.find((folder) => folder.folderPath === "src");
    expect(repoMap.topLevelFolders.find((folder) => folder.relativePath === "src")?.fileCount).toBe(
      srcFolder?.includedFiles,
    );

    const source = await readFile(path.join(root, "src", "index.ts"), "utf8");
    const compacted = progressiveCompact(source, { targetStage: 1 });
    expect(compacted.stage).toBe(1);
    expect(compacted.compactedTokens).toBeLessThan(compacted.originalTokens);
    expect(compacted.code).toContain("export function main");
    expect(compacted.code).not.toContain("Keep this comment");

    const tight = createRepoMap(scan, { tokenBudget: 10 });
    expect(tight.overflowNotes.join(" ")).toContain("Budget");
    expect(tight.entryPoints.map((file) => file.relativePath)).toContain("src/index.ts");
    const tightMarkdown = formatRepoMapMarkdown(tight);
    expect(tightMarkdown).toContain("src/index.ts");
    expect(tightMarkdown).toContain("Overflow Notes");
  });

  it("feeds scan totals through catalog queries and model recommendations", async () => {
    const root = await tempDirectory("tcalc-integration-catalog-");
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const catalogPath = path.join(root, "models.json");
    await writeFile(catalogPath, JSON.stringify(catalogFixture()));

    const scan = await scanWorkspace({ rootPath: root });
    const catalog = loadModelCatalog(catalogPath);
    expect(validateModelCatalog(catalog.models)).toEqual([]);

    const queried = queryModelCatalog(catalog.models, {
      filter: { searchTerm: "local", supportsLocal: true },
      sortBy: "codingScore",
      sortDirection: "desc",
      limit: 1,
    });
    expect(queried.models).toHaveLength(1);
    expect(queried.models[0].id).toBe("test/mid-local");
    expect(queried.aggregates.localModelsCount).toBe(2);

    const recommendation = recommendModels({
      models: catalog.models,
      workspaceTokens: scan.includedTokens,
      goal: "debug",
      privacyMode: "local-first",
      budget: 64_000,
    });
    expect(recommendation.workspaceTokens).toBe(scan.includedTokens);
    expect(recommendation.assumptions.join(" ")).toContain("20% safety margin");
    for (const tier of [recommendation.cheapestSufficient, recommendation.balanced, recommendation.highConfidence]) {
      expect(tier.modelId).not.toBe("test/cloud");
      expect(tier.overflowRisk).toBe(0);
    }

    const report = JSON.parse(generateJsonReport(scan, recommendation));
    expect(report.goal).toBe("debug");
    expect(report.recommendations.cheapestSufficient.modelId).toBe(recommendation.cheapestSufficient.modelId);
    expect(report.recommendations.balanced.modelId).toBe(recommendation.balanced.modelId);
  });

  it("surfaces corrupt catalog JSON through the CLI validation path", async () => {
    const root = await tempDirectory("tcalc-integration-corrupt-catalog-");
    const catalogPath = path.join(root, "models.json");
    await writeFile(catalogPath, "{ this is not valid JSON");

    await expect(executeCatalogValidate({ path: catalogPath })).rejects.toThrow(SyntaxError);
  });

  it("computes drift between two real scans and formats the policy report", async () => {
    const root = await tempDirectory("tcalc-integration-drift-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "src", "old.ts"), "export const legacy = true;\n");

    const baseline = await scanWorkspace({ rootPath: root });

    await writeFile(
      path.join(root, "src", "index.ts"),
      Array.from({ length: 120 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    );
    await rm(path.join(root, "src", "old.ts"));
    await writeFile(
      path.join(root, "src", "new.ts"),
      Array.from({ length: 80 }, (_, index) => `export function added${index}(): number { return ${index}; }`).join("\n"),
    );

    const current = await scanWorkspace({ rootPath: root });
    const drift = analyzeTokenDrift(baseline, current, {
      maxTokenIncrease: 0,
      maxDriftPercentage: 1,
    });

    expect(drift.baselineTotalTokens).toBe(baseline.totalEstimatedTokens);
    expect(drift.currentTotalTokens).toBe(current.totalEstimatedTokens);
    expect(drift.filesAdded).toBeGreaterThanOrEqual(1);
    expect(drift.filesRemoved).toBe(1);
    expect(drift.filesModified).toBe(1);
    expect(drift.topGrowingFiles.map((file) => file.relativePath)).toContain("src/new.ts");
    expect(drift.topShrinkingFiles.map((file) => file.relativePath)).toContain("src/old.ts");
    expect(drift.directoryDrifts[0].directory).toBe("src");
    expect(drift.violations.length).toBeGreaterThanOrEqual(2);
    expect(drift.passed).toBe(false);

    const markdown = formatDriftMarkdown(drift);
    expect(markdown).toContain("POLICY VIOLATION");
    expect(markdown).toContain("src/new.ts");
    expect(markdown).toContain("src/old.ts");
    expect(markdown).toContain("Policy Violations");
  });

  it("runs git status parsing and filtering against a real repository", async () => {
    const root = await tempDirectory("tcalc-integration-git-");
    await runGit(root, ["init"]);
    await runGit(root, ["config", "user.email", "test@example.com"]);
    await runGit(root, ["config", "user.name", "TCalc Test"]);
    await writeFile(path.join(root, "tracked file.ts"), "export const tracked = 1;\n");
    await writeFile(path.join(root, "clean.ts"), "export const clean = true;\n");
    await runGit(root, ["add", "."]);
    await runGit(root, ["commit", "-m", "initial"]);

    await writeFile(path.join(root, "tracked file.ts"), "export const tracked = 2;\n");
    await mkdir(path.join(root, "docs", "spec folder"), { recursive: true });
    await writeFile(path.join(root, "docs", "spec folder", "notes.md"), "# Notes\n");
    await runGit(root, ["mv", "tracked file.ts", "moved file.ts"]);

    const summary = await resolveGitStatus({ cwd: root });
    const moved = summary.entries.find((entry) => entry.path === "moved file.ts");

    expect(moved).toBeDefined();
    expect(moved?.originalPath).toBe("tracked file.ts");
    expect(moved?.isStaged).toBe(true);
    expect(moved?.isUnstaged).toBe(true);
    expect(summary.untrackedFiles).toContain("docs/spec folder/notes.md");

    const matcher = createGitStatusFilterPredicate(summary.entries, "all-dirty", root);
    expect(matcher(path.join(root, "moved file.ts"))).toBe(true);
    expect(matcher(path.join(root, "docs", "spec folder", "notes.md"))).toBe(true);
    expect(matcher(path.join(root, "clean.ts"))).toBe(false);
  });

  it("matches MCP batch token estimates with scanner output for the same files", async () => {
    const root = await tempDirectory("tcalc-integration-mcp-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    await writeFile(path.join(root, "src", "b.ts"), "export function add(x: number, y: number): number { return x + y; }\n");

    const scan = await scanWorkspace({ rootPath: root });
    const previousRoot = process.env.WMA_ALLOWED_ROOT;
    process.env.WMA_ALLOWED_ROOT = root;

    try {
      const response = await handleEstimateFilesTokens({
        filePaths: ["src/a.ts", "src/b.ts", "src/missing.ts"],
        workspaceRoot: root,
        contextBudget: 1_000,
      });
      const payload = JSON.parse(response.content[0].text);
      const scannedA = scan.files.find((file) => file.relativePath === "src/a.ts");
      const scannedB = scan.files.find((file) => file.relativePath === "src/b.ts");
      const expectedTokens = (scannedA?.estimatedTokens ?? 0) + (scannedB?.estimatedTokens ?? 0);

      expect(response.isError).toBeUndefined();
      expect(payload.totalFiles).toBe(3);
      expect(payload.existingFiles).toBe(2);
      expect(payload.totalTokens).toBe(expectedTokens);
      expect(payload.totalBytes).toBe((scannedA?.bytes ?? 0) + (scannedB?.bytes ?? 0));
      expect(payload.fitsBudget).toBe(expectedTokens <= 1_000);
      expect(payload.budgetUtilizationPercent).toBe(Number(((expectedTokens / 1_000) * 100).toFixed(2)));
      expect(payload.files.find((file: { relativePath: string }) => file.relativePath === "src/missing.ts")).toMatchObject({
        exists: false,
        error: "File not found",
      });
    } finally {
      if (previousRoot === undefined) delete process.env.WMA_ALLOWED_ROOT;
      else process.env.WMA_ALLOWED_ROOT = previousRoot;
    }
  });
});

async function writeWorkspaceFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "src", "generated"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "db"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export function main(): number {\n  // Keep this comment for compaction coverage.\n  return 1;\n}\n");
  await writeFile(
    path.join(root, "src", "feature.ts"),
    "export function feature(input: string): string {\n  return input.trim();\n}\n",
  );
  await writeFile(path.join(root, "src", "generated", "skip.ts"), "export const generated = true;\n");
  await writeFile(path.join(root, "src", "generated", ".gitignore"), "*.ts\n");
  await writeFile(path.join(root, "assets", "vendor.min.js"), "function a(){return 1}\n");
  await writeFile(path.join(root, "db", "schema.sql"), "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n");
  await writeFile(path.join(root, ".env"), "API_KEY=abcdefghijklmnop\n");
  await writeFile(
    path.join(root, "src", "secret.ts"),
    `${"// filler line for preview boundary\n".repeat(140)}const apiKey = "abcdefghijklmnop";\n`,
  );
  await writeFile(path.join(root, "README.md"), "# Demo workspace\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest" } }));
  await writeFile(path.join(root, "tsconfig.json"), "{}");
}

function catalogFixture(): { version: string; updatedAt: string; models: Array<Record<string, unknown>> } {
  return {
    version: "1.0",
    updatedAt: "2026-01-01",
    models: [
      {
        id: "test/tiny-local",
        displayName: "Tiny Local",
        provider: "test",
        contextWindow: 8_000,
        maxOutputTokens: 1_024,
        inputPricePerMillion: 0.01,
        cachedInputPricePerMillion: 0.005,
        outputPricePerMillion: 0.02,
        supportsTools: false,
        supportsImages: false,
        supportsLocal: true,
        privacyMode: "local",
        codingScore: 40,
        latencyScore: 95,
        updatedAt: "2026-01-01",
      },
      {
        id: "test/mid-local",
        displayName: "Mid Local",
        provider: "test",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        inputPricePerMillion: 0.2,
        cachedInputPricePerMillion: 0.1,
        outputPricePerMillion: 0.8,
        supportsTools: true,
        supportsImages: false,
        supportsLocal: true,
        privacyMode: "local",
        codingScore: 75,
        latencyScore: 70,
        updatedAt: "2026-01-01",
      },
      {
        id: "test/cloud",
        displayName: "Cloud Model",
        provider: "test",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        inputPricePerMillion: 10,
        cachedInputPricePerMillion: 5,
        outputPricePerMillion: 30,
        supportsTools: true,
        supportsImages: true,
        supportsLocal: false,
        privacyMode: "cloud",
        codingScore: 95,
        latencyScore: 50,
        updatedAt: "2026-01-01",
      },
    ],
  };
}

async function runGit(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}
