import { scanWorkspace } from "@wma/scanner";
import { generateAgentRules } from "@wma/agent-rules";
import type { AgentTarget, OptimizationMode } from "@wma/core";
import { existsSync } from "node:fs";
import { resolveTargetPath } from "../utils/paths.js";
import { CliError } from "../utils/errors.js";

export interface RulesOptions {
  target?: string;
  agentTarget: AgentTarget;
  mode: OptimizationMode;
  output?: string;
  yes?: boolean;
  debug?: boolean;
}

export async function executeRules(options: RulesOptions): Promise<{ content: string; fileName: string; outputPath?: string }> {
  const rootPath = resolveTargetPath(options.target);
  const scanResult = await scanWorkspace({ rootPath });

  const result = generateAgentRules({
    target: options.agentTarget,
    mode: options.mode,
    workspaceTokens: scanResult.includedTokens,
  });

  return {
    content: result.content,
    fileName: result.fileName,
  };
}

export function assertSafeRulesOutput(
  outputPath: string,
  fileName: string,
  force: boolean,
): void {
  if (fileName !== "AGENTS.md" || force || !existsSync(outputPath)) return;
  throw new CliError(
    `Refusing to overwrite existing ${outputPath}. Codex and generic targets write AGENTS.md; pass --force to replace it or --output to choose another file.`,
  );
}
