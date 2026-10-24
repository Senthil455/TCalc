import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  return {
    registered,
    selectWorkspaceRoot: vi.fn(),
    vscode: {
      commands: {
        registerCommand: vi.fn(
          (id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose: vi.fn() };
          },
        ),
      },
      window: {
        showQuickPick: vi.fn(),
        showInputBox: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showTextDocument: vi.fn(),
        showSaveDialog: vi.fn(),
      },
      workspace: {
        openTextDocument: vi.fn(),
        fs: { writeFile: vi.fn() },
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
      },
    },
  };
});

vi.mock("vscode", () => mocks.vscode, { virtual: true });
vi.mock("../src/workspaceContext.js", () => ({
  selectWorkspaceRoot: mocks.selectWorkspaceRoot,
}));

const {
  MCP_TARGET_OPTIONS,
  generateMcpConfig,
  getSuggestedFilename,
  registerGenerateMcpConfigCommand,
  suggestServerPath,
  validateServerPath,
} = await import("../src/commands/generateMcpConfigCommand.js");

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

async function createServerFile(root: string): Promise<string> {
  const serverPath = path.join(root, "mcp-server.mjs");
  await writeFile(serverPath, "console.log('server');");
  return serverPath;
}

describe("MCP config generation", () => {
  it("maps every quick-pick label to a stable target value", () => {
    expect(MCP_TARGET_OPTIONS.map((option) => option.label)).toEqual([
      "Cursor",
      "Continue",
      "Claude Desktop",
      "Generic MCP",
    ]);
    expect(MCP_TARGET_OPTIONS.map((option) => option.target)).toEqual([
      "cursor",
      "continue",
      "claude-desktop",
      "generic",
    ]);
  });

  it("generates valid JSON for Cursor, Claude Desktop, and Generic MCP", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");
    const serverPath = await createServerFile(root);

    for (const target of ["cursor", "claude-desktop", "generic"] as const) {
      const content = generateMcpConfig(target, serverPath, root);
      const parsed = JSON.parse(content) as {
        mcpServers: {
          tcalc: { args: string[]; env: { WMA_ALLOWED_ROOT: string } };
        };
      };
      expect(parsed.mcpServers.tcalc.args).toEqual([serverPath]);
      expect(parsed.mcpServers.tcalc.env.WMA_ALLOWED_ROOT).toBe(root);
    }
  });

  it("generates a Continue YAML entry with the allowed root", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");
    const serverPath = await createServerFile(root);

    const content = generateMcpConfig("continue", serverPath, root);

    expect(content).toContain(JSON.stringify(serverPath));
    expect(content).toContain(`WMA_ALLOWED_ROOT: ${JSON.stringify(root)}`);
  });

  it("returns a filename for every target", () => {
    for (const target of ["cursor", "continue", "claude-desktop", "generic"] as const) {
      expect(getSuggestedFilename(target)).toMatch(/\.(json|yaml)$/);
    }
  });

  it("validates that the server entry point is an existing file", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");
    const serverPath = await createServerFile(root);

    expect(validateServerPath(serverPath)).toBe(serverPath);
    expect(() => validateServerPath(path.join(root, "missing.js"))).toThrow(
      "MCP server entry point not found",
    );
    expect(() => validateServerPath(root)).toThrow(
      "MCP server entry point not found",
    );
  });

  it("does not guess a server path when the extension has no bundled server", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");
    await mkdir(path.join(root, "empty"));
    expect(suggestServerPath(path.join(root, "empty"))).toBeUndefined();
  });
});

describe("generateMcpConfig command", () => {
  beforeEach(() => {
    mocks.registered.clear();
    mocks.selectWorkspaceRoot.mockReset();
    mocks.vscode.commands.registerCommand.mockClear();
    mocks.vscode.window.showQuickPick.mockReset();
    mocks.vscode.window.showInputBox.mockReset();
    mocks.vscode.window.showErrorMessage.mockReset();
    mocks.vscode.window.showInformationMessage.mockReset();
    mocks.vscode.window.showTextDocument.mockReset();
    mocks.vscode.workspace.openTextDocument.mockReset();
  });

  it("stops before the target picker when no workspace is open", async () => {
    mocks.selectWorkspaceRoot.mockResolvedValue(undefined);
    registerGenerateMcpConfigCommand();

    const handler = mocks.registered.get("workspaceModelAdvisor.generateMcpConfig");
    await handler?.();

    expect(mocks.vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("generates a valid document for Claude Desktop and Generic MCP", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");
    const serverPath = await createServerFile(root);
    const contents: string[] = [];

    mocks.selectWorkspaceRoot.mockResolvedValue(root);
    mocks.vscode.workspace.openTextDocument.mockImplementation(
      async ({ content }: { content: string }) => {
        contents.push(content);
        return {};
      },
    );
    mocks.vscode.window.showInformationMessage.mockResolvedValue(undefined);
    registerGenerateMcpConfigCommand({ extensionPath: root } as never);

    const handler = mocks.registered.get("workspaceModelAdvisor.generateMcpConfig");

    for (const label of ["Claude Desktop", "Generic MCP"]) {
      const option = MCP_TARGET_OPTIONS.find((item) => item.label === label)!;
      mocks.vscode.window.showQuickPick.mockResolvedValue(option);
      mocks.vscode.window.showInputBox.mockResolvedValue(serverPath);

      await handler?.(root);

      expect(mocks.vscode.window.showErrorMessage).not.toHaveBeenCalled();
      const content = contents.at(-1)!;
      const parsed = JSON.parse(content) as {
        mcpServers: {
          tcalc: { env: { WMA_ALLOWED_ROOT: string } };
        };
      };
      expect(parsed.mcpServers.tcalc.env.WMA_ALLOWED_ROOT).toBe(root);
    }

    expect(contents).toHaveLength(2);
  });

  it("reports an invalid server path instead of generating a broken config", async () => {
    const root = await tempDirectory("tcalc-mcp-config-");

    mocks.selectWorkspaceRoot.mockResolvedValue(root);
    mocks.vscode.window.showQuickPick.mockResolvedValue(
      MCP_TARGET_OPTIONS[0],
    );
    mocks.vscode.window.showInputBox.mockResolvedValue(
      path.join(root, "missing.js"),
    );
    registerGenerateMcpConfigCommand({ extensionPath: root } as never);

    const handler = mocks.registered.get("workspaceModelAdvisor.generateMcpConfig");
    await handler?.(root);

    expect(mocks.vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("MCP server entry point not found"),
    );
    expect(mocks.vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});
