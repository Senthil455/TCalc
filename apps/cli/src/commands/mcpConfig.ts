import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveTargetPath } from "../utils/paths.js";
import { CliError } from "../utils/errors.js";

export interface McpConfigOptions {
  target: McpTarget;
  command?: string;
  workspace?: string;
}

export interface ResolveDefaultCommandOptions {
  resolveModule?: (specifier: string) => string;
  isFile?: (filePath: string) => boolean;
}

export type McpTarget = "cursor" | "continue" | "claude-desktop" | "generic";

export function resolveDefaultCommand(options: ResolveDefaultCommandOptions = {}): string {
  const resolveModule =
    options.resolveModule ?? ((specifier: string) => createRequire(import.meta.url).resolve(specifier));
  const isFile = options.isFile ?? ((filePath: string) => statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false);

  let entry: string;
  try {
    entry = resolveModule("@wma/mcp-server");
  } catch {
    throw new CliError(
      "Cannot resolve the TCalc MCP server package @wma/mcp-server from this CLI installation. Reinstall TCalc or pass --command <path-to-mcp-server-entry>.",
    );
  }

  if (!isFile(entry)) {
    throw new CliError(
      `The TCalc MCP server entry point does not exist or is not a file: ${entry}. Reinstall TCalc or pass --command <path-to-mcp-server-entry>.`,
    );
  }

  return entry;
}

export function generateMcpConfig(options: McpConfigOptions): string {
  const serverCommand = options.command ?? resolveDefaultCommand();
  const workspace = resolveTargetPath(options.workspace);

  switch (options.target) {
    case "cursor":
      return generateCursorConfig(serverCommand, workspace);
    case "continue":
      return generateContinueConfig(serverCommand, workspace);
    case "claude-desktop":
      return generateClaudeDesktopConfig(serverCommand, workspace);
    case "generic":
      return generateGenericConfig(serverCommand, workspace);
  }
}

function generateCursorConfig(command: string, workspace: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        tcalc: {
          command: "node",
          args: [command],
          env: { WMA_ALLOWED_ROOT: workspace },
          description: "Local-first workspace analysis and AI model recommendations",
        },
      },
    },
    null,
    2,
  );
}

function generateContinueConfig(command: string, workspace: string): string {
  return `# Continue MCP Configuration (add to config.yaml)
experimental:
  modelContextProtocolServers:
    - transport: stdio
      command: node
      args:
        - ${JSON.stringify(command)}
      env:
        WMA_ALLOWED_ROOT: ${JSON.stringify(workspace)}
      description: TCalc workspace analysis tools
`;
}

function generateClaudeDesktopConfig(command: string, workspace: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        tcalc: {
          command: "node",
          args: [command],
          env: { WMA_ALLOWED_ROOT: workspace },
          description: "Local-first workspace analysis and AI model recommendations",
          disabled: false,
          autoApprove: [],
        },
      },
    },
    null,
    2,
  );
}

function generateGenericConfig(command: string, workspace: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        tcalc: {
          command: "node",
          args: [command],
          env: { WMA_ALLOWED_ROOT: workspace },
          description: "Local-first workspace analysis and AI model recommendations",
        },
      },
    },
    null,
    2,
  );
}
