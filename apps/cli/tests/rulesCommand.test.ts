import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeRules, assertSafeRulesOutput } from "../src/commands/rules.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("rules command", () => {
  it("generates generic AGENTS.md content", async () => {
    const result = await executeRules({
      target: "fixtures/small-node-app",
      agentTarget: "generic",
      mode: "normal",
    });
    expect(result.fileName).toBe("AGENTS.md");
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain("Agent Rules");
  });

  it("generates cursor rules", async () => {
    const result = await executeRules({
      target: "fixtures/small-node-app",
      agentTarget: "cursor",
      mode: "concise",
    });
    expect(result.fileName).toBe(".cursorrules");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("generates Claude rules", async () => {
    const result = await executeRules({
      target: "fixtures/small-node-app",
      agentTarget: "claude-code",
      mode: "patch-only",
    });
    expect(result.fileName).toBe("CLAUDE.md");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("generates AGENTS.md for Codex", async () => {
    const result = await executeRules({
      target: "fixtures/small-node-app",
      agentTarget: "codex",
      mode: "repo-map-first",
    });
    expect(result.fileName).toBe("AGENTS.md");
    expect(result.content).toContain("codex Agent Rules");
  });

  it("refuses to overwrite an existing AGENTS.md without force", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tcalc-rules-"));
    cleanup.push(root);
    const outputPath = path.join(root, "AGENTS.md");
    await writeFile(outputPath, "hand-written instructions");

    expect(() => assertSafeRulesOutput(outputPath, "AGENTS.md", false)).toThrow(
      "Refusing to overwrite existing",
    );
    expect(() => assertSafeRulesOutput(outputPath, "AGENTS.md", true)).not.toThrow();
  });

  it("allows other targets to keep their existing overwrite behavior", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tcalc-rules-"));
    cleanup.push(root);
    const outputPath = path.join(root, ".cursorrules");
    await writeFile(outputPath, "existing cursor rules");

    expect(() => assertSafeRulesOutput(outputPath, ".cursorrules", false)).not.toThrow();
  });
});
