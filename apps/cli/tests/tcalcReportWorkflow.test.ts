import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.github/workflows/tcalc-report.yml",
  ),
  "utf8",
);

describe("TCalc Report workflow", () => {
  it("grants the minimum permissions needed for an optional PR comment", () => {
    expect(workflow).toMatch(
      /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/,
    );
  });

  it("does not expose a write token through pull_request_target", () => {
    expect(workflow).not.toContain("pull_request_target");
  });

  it("keeps the comment step limited to trusted same-repository PRs", () => {
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("makes the optional comment non-fatal", () => {
    expect(workflow).toMatch(
      /Comment PR summary \(trusted PRs only\)[\s\S]*?continue-on-error: true/,
    );
  });

  it("generates and uploads reports before attempting the comment", () => {
    const reportUpload = workflow.indexOf("Upload workspace model report");
    const comment = workflow.indexOf("Comment PR summary");

    expect(reportUpload).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(reportUpload);
  });
});
