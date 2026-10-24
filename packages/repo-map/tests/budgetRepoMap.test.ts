import { describe, it, expect } from "vitest";
import type {
  RepoMapResult, RepoMapFile, RepoMapFolder, RepoMapLanguage,
} from "@wma/core";
import { budgetRepoMap } from "../src/budgetRepoMap.js";
import { formatRepoMapMarkdown } from "../src/formatRepoMapMarkdown.js";
import { estimateTokens } from "@wma/tokenizers";

function makeFile(relativePath: string, priority: number, estimatedTokens: number): RepoMapFile {
  return {
    relativePath,
    estimatedTokens,
    reason: "test",
    priority,
    language: "TypeScript",
  };
}

function makeResult(overrides: Partial<RepoMapResult>): RepoMapResult {
  return {
    rootPath: "/test",
    generatedAt: new Date().toISOString(),
    tokenBudget: 8000,
    estimatedTokens: 5000,
    workspaceTotalTokens: 50000,
    summary: "Test summary",
    topLevelFolders: [],
    languageBreakdown: [],
    importantFiles: [],
    entryPoints: [],
    testFiles: [],
    configFiles: [],
    documentationFiles: [],
    riskyFiles: [],
    largeFiles: [],
    generatedFiles: [],
    excludedFiles: [],
    recommendedInclude: [],
    recommendedExclude: [],
    agentInstructions: [],
    overflowNotes: [],
    symbols: [],
    imports: [],
    routes: [],
    symbolSummary: [],
    ...overrides,
  };
}

describe("budgetRepoMap", () => {
  it("trims lower-priority files first", () => {
    const entryPoint = makeFile("src/index.ts", 100, 200);
    const largeFile = makeFile("data/huge.json", 20, 100000);
    const testFile = makeFile("test/foo.test.ts", 70, 300);
    const sourceFile = makeFile("src/util.ts", 60, 200);

    const result = makeResult({
      tokenBudget: 300,
      estimatedTokens: 100700,
      entryPoints: [entryPoint],
      testFiles: [testFile],
      largeFiles: [largeFile],
      importantFiles: [entryPoint, testFile, sourceFile, largeFile],
    });

    const budgeted = budgetRepoMap(result, 300);

    const remainingPaths = budgeted.importantFiles.map((f) => f.relativePath);
    expect(remainingPaths).not.toContain("data/huge.json");
    expect(budgeted.overflowNotes.length).toBeGreaterThan(0);
  });

  it("keeps entry points, configs, and docs before low-priority files", () => {
    const entryPoint = makeFile("src/index.ts", 100, 500);
    const config = makeFile("package.json", 90, 100);
    const doc = makeFile("README.md", 80, 100);
    const largeFile = makeFile("data/huge.json", 20, 100000);

    const result = makeResult({
      tokenBudget: 300,
      estimatedTokens: 100700,
      entryPoints: [entryPoint],
      configFiles: [config],
      documentationFiles: [doc],
      largeFiles: [largeFile],
      importantFiles: [entryPoint, config, doc, largeFile],
    });

    const budgeted = budgetRepoMap(result, 300);

    const remainingPaths = budgeted.importantFiles.map((f) => f.relativePath);
    expect(remainingPaths).toContain("src/index.ts");
    expect(remainingPaths).toContain("package.json");
    expect(remainingPaths).toContain("README.md");
    expect(remainingPaths).not.toContain("data/huge.json");
  });

  it("handles 2K budget", () => {
    const files: RepoMapFile[] = [
      makeFile("src/index.ts", 100, 300),
      makeFile("package.json", 90, 100),
      makeFile("README.md", 80, 100),
      makeFile("test/foo.test.ts", 70, 200),
      makeFile("data/big.json", 20, 50000),
    ];

    const result = makeResult({
      tokenBudget: 2000,
      estimatedTokens: 50700,
      entryPoints: [files[0]],
      configFiles: [files[1]],
      documentationFiles: [files[2]],
      testFiles: [files[3]],
      largeFiles: [files[4]],
      importantFiles: files,
    });

    const budgeted = budgetRepoMap(result, 2000);

    expect(budgeted.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(budgeted.overflowNotes).toHaveLength(0);
  });

  it("handles 16K budget without trimming when under budget", () => {
    const files: RepoMapFile[] = [
      makeFile("src/index.ts", 100, 500),
      makeFile("package.json", 90, 100),
    ];

    const result = makeResult({
      tokenBudget: 16000,
      estimatedTokens: 600,
      entryPoints: [files[0]],
      configFiles: [files[1]],
      importantFiles: files,
    });

    const budgeted = budgetRepoMap(result, 16000);

    expect(budgeted.importantFiles).toHaveLength(2);
    expect(budgeted.overflowNotes).toHaveLength(0);
  });

  it("budgets the final serialized Markdown", () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      makeFile(`src/very-long-file-name-${index}.ts`, 10, 100_000));
    const result = makeResult({
      tokenBudget: 500,
      estimatedTokens: 3_000_000,
      importantFiles: files,
      testFiles: files,
      recommendedInclude: files,
    });

    const budgeted = budgetRepoMap(result, 500);
    const serializedTokens = estimateTokens(formatRepoMapMarkdown(budgeted));

    expect(serializedTokens).toBe(budgeted.estimatedTokens);
    expect(serializedTokens).toBeLessThanOrEqual(500);
  });

  it("refreshes summary and agent instructions after trimming", () => {
    const entryPoint = makeFile("src/index.ts", 100, 200);
    const largeFile = makeFile("data/huge.json", 20, 100_000);
    const generatedFile = makeFile("dist/bundle.js", 10, 50_000);
    const riskyFile = makeFile(".env", 10, 10);
    const sourceFile = makeFile("src/util.ts", 60, 200);

    const result = makeResult({
      tokenBudget: 100,
      estimatedTokens: 150_000,
      summary: [
        "Files: 10 included / 2 excluded (83.3% of 12 total)",
        "Important files identified: 5",
        "Entry points: 1",
        "Tests: 0",
        "Config files: 0",
        "Documentation files: 0",
        "Large files: 1",
        "Risky files: 1",
        "Tokens in important files: ~150,410",
        "Workspace total: ~500,000 tokens",
      ].join("\n"),
      entryPoints: [entryPoint],
      largeFiles: [largeFile],
      generatedFiles: [generatedFile],
      riskyFiles: [riskyFile],
      importantFiles: [entryPoint, largeFile, generatedFile, riskyFile, sourceFile],
      agentInstructions: [
        "Start by reading this repo map to understand the workspace structure.",
        "Key entry points to read first: src/index.ts",
        "There are 1 large file(s). Ask before reading them.",
        "There are 1 potentially sensitive file(s). Ask before reading.",
        "There are 1 generated file(s). Avoid editing them.",
      ],
    });

    const budgeted = budgetRepoMap(result, 100);

    expect(budgeted.importantFiles.map((file) => file.relativePath)).toEqual([
      "src/index.ts",
    ]);
    expect(budgeted.summary).toContain("Important files identified: 1");
    expect(budgeted.summary).toContain("Entry points: 1");
    expect(budgeted.summary).toContain("Large files: 0");
    expect(budgeted.summary).toContain("Risky files: 0");
    expect(budgeted.summary).toContain("Tokens in important files: ~200");
    expect(budgeted.summary).toContain("Files: 10 included / 2 excluded (83.3% of 12 total)");
    expect(budgeted.summary).toContain("Workspace total: ~500,000 tokens");

    const instructions = budgeted.agentInstructions.join("\n");
    expect(instructions).toContain("Key entry points to read first: src/index.ts");
    expect(instructions).not.toContain("large file(s)");
    expect(instructions).not.toContain("sensitive file(s)");
    expect(instructions).not.toContain("generated file(s)");
    expect(instructions).not.toContain("data/huge.json");
    expect(instructions).not.toContain("dist/bundle.js");
  });

  it("explains when the preserved high-priority sections exceed the budget", () => {
    const entryPoint = makeFile("src/index.ts", 100, 5000);
    const result = makeResult({
      tokenBudget: 100,
      estimatedTokens: 5000,
      entryPoints: [entryPoint],
      importantFiles: [entryPoint],
    });

    const budgeted = budgetRepoMap(result, 100);

    expect(budgeted.importantFiles).toHaveLength(1);
    expect(budgeted.estimatedTokens).toBeGreaterThan(100);
    expect(budgeted.overflowNotes.join("\n")).toContain(
      "required high-priority sections",
    );
    expect(estimateTokens(formatRepoMapMarkdown(budgeted))).toBe(
      budgeted.estimatedTokens,
    );
  });

  it("removes code metadata for trimmed source files", () => {
    const file = makeFile("src/large.ts", 10, 100_000);
    const result = makeResult({
      importantFiles: [file],
      largeFiles: [file],
      symbols: [{ name: "large", kind: "function", relativePath: file.relativePath, priority: 1 }],
      imports: [{ source: "./other", relativePath: file.relativePath, kind: "import" }],
      routes: [{ relativePath: file.relativePath, routePattern: "/large", reason: "test" }],
      symbolSummary: ["1 symbols extracted from 1 files"],
    });

    const budgeted = budgetRepoMap(result, 100);
    expect(budgeted.importantFiles).toHaveLength(0);
    expect(budgeted.symbols).toHaveLength(0);
    expect(budgeted.imports).toHaveLength(0);
    expect(budgeted.routes).toHaveLength(0);
    expect(budgeted.symbolSummary).toHaveLength(0);
  });
});
