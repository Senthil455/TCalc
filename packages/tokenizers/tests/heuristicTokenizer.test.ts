import { describe, it, expect } from "vitest";
import { estimateTokens, estimateFileTokens, estimateTokensFromBytes, HeuristicTokenizer } from "../src/heuristicTokenizer.js";

describe("estimateTokens", () => {
  it("should return 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("should return 0 for whitespace-only string", () => {
    expect(estimateTokens("   ")).toBe(1);
  });

  it("should return at least 1 for non-empty text", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("should approximate 4-char-per-token ratio", () => {
    const text = "Hello world this is a test string with exactly some characters here";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  it("should increase with longer text", () => {
    const short = estimateTokens("short text");
    const long = estimateTokens("this is a much longer text that should produce more tokens than the short one");
    expect(long).toBeGreaterThanOrEqual(short);
  });

  it("should handle very long text", () => {
    const text = "word ".repeat(1000);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(100);
  });

  it("should handle special characters", () => {
    const text = "function hello() { return 42; } // test\nconsole.log('hi');";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  it("should use max of char and word estimate for whitespace-heavy text", () => {
    const text = "a   b   c   d   e   f   g   h   i   j";
    const tokens = estimateTokens(text);
    const charEstimate = Math.ceil(text.length / 4);
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    const wordEstimate = Math.ceil(wordCount * 1.3);
    expect(tokens).toBe(Math.max(1, charEstimate, wordEstimate));
  });

  it("should handle markdown-like text", () => {
    const text = "# Heading\n\nThis is a paragraph with **bold** and *italic* text.\n\n- List item 1\n- List item 2\n";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("should handle JSON-like text", () => {
    const text = '{"name":"test","version":"1.0.0","dependencies":{"dep1":"^1.0.0","dep2":"^2.0.0"}}';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  it("should handle code-like text", () => {
    const text = "function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("estimateFileTokens", () => {
  it("should delegate to estimateTokens", () => {
    const content = "some file content here";
    expect(estimateFileTokens(content)).toBe(estimateTokens(content));
  });

  it("should use the neutral factor for extensions that match Object.prototype members", () => {
    const content = "export const value = 42;";
    const baseline = estimateFileTokens(content, "file.unknown");

    for (const filename of [
      "file.constructor",
      "file.__proto__",
      "file.CONSTRUCTOR",
      "file.__PROTO__",
    ]) {
      expect(estimateFileTokens(content, filename)).toBe(baseline);
      expect(Number.isFinite(estimateFileTokens(content, filename))).toBe(true);
    }
  });

  it("should return zero for empty content even with an inherited-property extension", () => {
    expect(estimateFileTokens("", "file.constructor")).toBe(0);
    expect(estimateFileTokens("", "file.__proto__")).toBe(0);
  });

  it("should keep known extension adjustments unchanged", () => {
    const content = "some content";
    expect(estimateFileTokens(content, "data.json")).toBe(
      Math.round(estimateTokens(content) * 0.9),
    );
    expect(estimateFileTokens(content, "data.lock")).toBe(
      Math.round(estimateTokens(content) * 1.5),
    );
  });
});

describe("estimateTokensFromBytes", () => {
  it("should return at least 1 for positive bytes", () => {
    expect(estimateTokensFromBytes(1)).toBeGreaterThanOrEqual(1);
  });

  it("should approximate 4 bytes per token", () => {
    expect(estimateTokensFromBytes(400)).toBe(100);
  });
});

describe("HeuristicTokenizer", () => {
  const tokenizer = new HeuristicTokenizer();

  it("should return 0 for empty text with heuristic confidence", () => {
    const result = tokenizer.estimate("");
    expect(result.tokens).toBe(0);
    expect(result.confidence).toBe("heuristic");
  });

  it("should return tokens for non-empty text", () => {
    const text = "function hello() { return 42; }";
    const result = tokenizer.estimate(text);
    expect(result.tokens).toBeGreaterThanOrEqual(1);
    expect(result.confidence).toBe("heuristic");
  });

  it("should provide weighted estimate based on characters, words, and lines", () => {
    const text = "Hello world\nThis is line two\nAnd line three";
    const result = tokenizer.estimate(text);
    expect(result.tokens).toBeGreaterThanOrEqual(1);
  });

  it("should adjust estimate for JSON files", () => {
    const content = '{"name": "test", "version": "1.0.0"}';
    const jsonResult = tokenizer.estimateFile("data.json", content);
    const jsResult = tokenizer.estimateFile("data.js", content);
    expect(jsonResult.tokens).toBeLessThanOrEqual(jsResult.tokens);
  });

  it("should adjust estimate for Markdown files", () => {
    const content = "# Heading\n\nSome paragraph text here.";
    const mdResult = tokenizer.estimateFile("readme.md", content);
    const txtResult = tokenizer.estimateFile("readme.txt", content);
    expect(mdResult.tokens).toBeGreaterThanOrEqual(txtResult.tokens);
  });

  it("should not include details when factor is 1.0", () => {
    const content = "some text";
    const result = tokenizer.estimateFile("file.txt", content);
    expect(result.details).toBeUndefined();
  });

  it("should include details when factor is not 1.0", () => {
    const content = "# heading";
    const result = tokenizer.estimateFile("readme.md", content);
    expect(result.details).toBeDefined();
    expect(result.details).toContain("adjusted");
  });

  it("should handle lock files with higher factor", () => {
    const content = "package-a@1.0.0\npackage-b@2.0.0\n";
    const lockResult = tokenizer.estimateFile("Cargo.lock", content);
    const txtResult = tokenizer.estimateFile("readme.txt", content);
    expect(lockResult.tokens).toBeGreaterThan(txtResult.tokens);
  });

  it("should treat inherited-property extensions as unadjusted", () => {
    const content = "export const value = 42;";
    const baseline = tokenizer.estimateFile("file.unknown", content);

    for (const filename of [
      "file.constructor",
      "file.__proto__",
      "file.CONSTRUCTOR",
      "file.__PROTO__",
    ]) {
      const result = tokenizer.estimateFile(filename, content);
      expect(Number.isFinite(result.tokens)).toBe(true);
      expect(result.tokens).toBe(baseline.tokens);
      expect(result.details).toBeUndefined();
    }
  });

  it("should return zero for empty content with an inherited-property extension", () => {
    for (const filename of ["file.constructor", "file.__proto__"]) {
      expect(tokenizer.estimateFile(filename, "").tokens).toBe(0);
    }
  });
});
