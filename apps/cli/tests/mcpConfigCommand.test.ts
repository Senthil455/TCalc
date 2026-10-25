import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateMcpConfig,
  resolveDefaultCommand,
} from "../src/commands/mcpConfig.js";
import { CliError } from "../src/utils/errors.js";

describe("mcp-config command", () => {
  it("generates valid JSON for Cursor target", () => {
    const output = generateMcpConfig({
      target: "cursor",
      command: "/path/to/mcp-server/dist/index.js",
    });
    const parsed = JSON.parse(output);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.tcalc).toBeDefined();
    expect(parsed.mcpServers.tcalc.command).toBe("node");
    expect(parsed.mcpServers.tcalc.args).toContain("/path/to/mcp-server/dist/index.js");
    expect(parsed.mcpServers.tcalc.env.WMA_ALLOWED_ROOT).toBe(process.cwd());
  });

  it("generates valid JSON for generic target", () => {
    const output = generateMcpConfig({
      target: "generic",
      command: "/path/to/mcp-server/dist/index.js",
    });
    const parsed = JSON.parse(output);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.tcalc.command).toBe("node");
  });

  it("generates valid JSON for claude-desktop target", () => {
    const output = generateMcpConfig({
      target: "claude-desktop",
      command: "/path/to/mcp-server/dist/index.js",
    });
    const parsed = JSON.parse(output);
    expect(parsed.mcpServers.tcalc.disabled).toBe(false);
    expect(parsed.mcpServers.tcalc.autoApprove).toEqual([]);
  });

  it("generates YAML output for continue target", () => {
    const output = generateMcpConfig({
      target: "continue",
      command: "/path/to/mcp-server/dist/index.js",
    });
    expect(output).toContain("experimental:");
    expect(output).toContain("modelContextProtocolServers:");
    expect(output).toContain("transport: stdio");
    expect(output).toContain("command: node");
    expect(output).toContain("/path/to/mcp-server/dist/index.js");
  });

  it("uses default command when not specified", () => {
    const output = generateMcpConfig({ target: "generic" });
    const parsed = JSON.parse(output);
    const command = parsed.mcpServers.tcalc.args[0];

    expect(path.isAbsolute(command)).toBe(true);
    expect(statSync(command).isFile()).toBe(true);
  });

  it("resolves the default command from an unrelated working directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tcalc-mcp-cwd-"));
    const previous = process.cwd();

    try {
      process.chdir(directory);
      const parsed = JSON.parse(generateMcpConfig({ target: "generic" }));
      const command = parsed.mcpServers.tcalc.args[0];

      expect(path.isAbsolute(command)).toBe(true);
      expect(statSync(command).isFile()).toBe(true);
    } finally {
      process.chdir(previous);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves the MCP server from a packed dependency layout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tcalc-mcp-packed-"));
    const packageDir = path.join(directory, "node_modules", "@wma", "mcp-server");

    try {
      await mkdir(path.join(packageDir, "dist"), { recursive: true });
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "@wma/mcp-server", version: "1.0.0", main: "dist/index.js" }),
      );
      await writeFile(path.join(packageDir, "dist", "index.js"), "export {};\n");

      const requireFromApp = createRequire(path.join(directory, "app.js"));
      const command = resolveDefaultCommand({
        resolveModule: (specifier) => requireFromApp.resolve(specifier),
      });

      expect(command).toBe(path.join(packageDir, "dist", "index.js"));
      expect(statSync(command).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports an actionable error when the package cannot be resolved", () => {
    expect(() =>
      resolveDefaultCommand({
        resolveModule: () => {
          throw new Error("MODULE_NOT_FOUND");
        },
      }),
    ).toThrow(CliError);
    expect(() =>
      resolveDefaultCommand({
        resolveModule: () => {
          throw new Error("MODULE_NOT_FOUND");
        },
      }),
    ).toThrow(/Cannot resolve the TCalc MCP server package.*--command/);
  });

  it("reports an actionable error when the resolved entry point is missing", () => {
    const missing = path.join(tmpdir(), "tcalc-missing-mcp-server", "index.js");

    expect(() => resolveDefaultCommand({ resolveModule: () => missing })).toThrow(CliError);
    expect(() => resolveDefaultCommand({ resolveModule: () => missing })).toThrow(
      /does not exist or is not a file.*--command/,
    );
  });

  it("preserves an explicitly supplied command without validating it", () => {
    const command = path.join(tmpdir(), "explicit-command-does-not-exist.js");
    const parsed = JSON.parse(generateMcpConfig({ target: "generic", command }));

    expect(parsed.mcpServers.tcalc.args[0]).toBe(command);
  });

  it("generates JSON without secrets", () => {
    const output = generateMcpConfig({
      target: "cursor",
      command: "/path/to/mcp-server/dist/index.js",
    });
    expect(output).not.toContain("token");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("password");
    expect(output).not.toContain("api_key");
    expect(output).not.toContain("authorization");
  });
});
