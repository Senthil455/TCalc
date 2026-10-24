import * as vscode from "vscode";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { selectWorkspaceRoot } from "../workspaceContext.js";

export type McpTarget = "cursor" | "continue" | "claude-desktop" | "generic";

export interface McpTargetOption {
  label: string;
  description: string;
  target: McpTarget;
}

export const MCP_TARGET_OPTIONS: readonly McpTargetOption[] = [
  { label: "Cursor", description: ".cursor/mcp.json MCP config", target: "cursor" },
  { label: "Continue", description: "config.yaml MCP entry", target: "continue" },
  {
    label: "Claude Desktop",
    description: "claude_desktop_config.json MCP entry",
    target: "claude-desktop",
  },
  { label: "Generic MCP", description: "Any stdio MCP client", target: "generic" },
];

export function generateMcpConfig(
  target: McpTarget,
  serverPath: string,
  workspaceRoot: string,
): string {
  switch (target) {
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            tcalc: {
              command: "node",
              args: [serverPath],
              env: { WMA_ALLOWED_ROOT: workspaceRoot },
              description:
                "Local-first workspace analysis and AI model recommendations",
            },
          },
        },
        null,
        2,
      );
    case "continue":
      return `# Continue MCP Configuration (add to config.yaml)
experimental:
  modelContextProtocolServers:
    - transport: stdio
      command: node
      args:
        - ${JSON.stringify(serverPath)}
      env:
        WMA_ALLOWED_ROOT: ${JSON.stringify(workspaceRoot)}
      description: TCalc workspace analysis tools
`;
    case "claude-desktop":
      return JSON.stringify(
        {
          mcpServers: {
            tcalc: {
              command: "node",
              args: [serverPath],
              env: { WMA_ALLOWED_ROOT: workspaceRoot },
              description:
                "Local-first workspace analysis and AI model recommendations",
              disabled: false,
              autoApprove: [],
            },
          },
        },
        null,
        2,
      );
    case "generic":
      return JSON.stringify(
        {
          mcpServers: {
            tcalc: {
              command: "node",
              args: [serverPath],
              env: { WMA_ALLOWED_ROOT: workspaceRoot },
              description:
                "Local-first workspace analysis and AI model recommendations",
            },
          },
        },
        null,
        2,
      );
  }
}

export function getSuggestedFilename(target: McpTarget): string {
  switch (target) {
    case "cursor":
      return "cursor.mcp.json";
    case "continue":
      return "continue-mcp.yaml";
    case "claude-desktop":
      return "claude-desktop-mcp.json";
    case "generic":
      return "mcp-stdio.json";
  }
}

export function suggestServerPath(extensionPath?: string): string | undefined {
  if (!extensionPath) return undefined;

  const candidates = [
    path.join(extensionPath, "node_modules", "@wma", "mcp-server", "dist", "index.js"),
    path.resolve(extensionPath, "..", "..", "packages", "mcp-server", "dist", "index.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function validateServerPath(serverPath: string): string {
  const resolved = path.resolve(serverPath);
  try {
    if (!statSync(resolved).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`MCP server entry point not found: ${resolved}`);
  }
  return resolved;
}

export function registerGenerateMcpConfigCommand(
  context?: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    "workspaceModelAdvisor.generateMcpConfig",
    async (requestedRootPath?: string) => {
      const workspaceRoot = await selectWorkspaceRoot(requestedRootPath);
      if (!workspaceRoot) return;

      const target = await vscode.window.showQuickPick(
        MCP_TARGET_OPTIONS.map((option) => ({ ...option })),
        { placeHolder: "Select target tool for MCP config" },
      );
      if (!target) return;

      const suggested = suggestServerPath(context?.extensionPath);
      const input = await vscode.window.showInputBox({
        prompt: "Path to MCP server entry point",
        value: suggested,
        placeHolder: "/absolute/path/to/mcp-server/dist/index.js",
        title: `MCP Server Path for ${target.label}`,
      });
      if (input === undefined) return;

      let serverPath: string;
      try {
        serverPath = validateServerPath(input);
      } catch (error) {
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      const configContent = generateMcpConfig(
        target.target,
        serverPath,
        workspaceRoot,
      );
      const suggestedName = getSuggestedFilename(target.target);

      const doc = await vscode.workspace.openTextDocument({
        content: configContent,
        language: /yaml/i.test(suggestedName) ? "yaml" : "json",
      });
      await vscode.window.showTextDocument(doc);

      const save = await vscode.window.showInformationMessage(
        `Generated ${target.label} MCP config. Save to file?`,
        "Save",
      );

      if (save === "Save") {
        const defaultUri = vscode.Uri.file(
          path.join(workspaceRoot, suggestedName),
        );
        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { "Config files": ["json", "yaml"] },
          title: `Save ${target.label} MCP Config`,
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(
            uri,
            new TextEncoder().encode(configContent),
          );
          vscode.window.showInformationMessage(
            `MCP config saved to ${uri.fsPath}`,
          );
        }
      }
    },
  );
}
