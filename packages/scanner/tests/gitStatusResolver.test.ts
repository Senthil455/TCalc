import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseGitStatusPorcelain,
  resolveGitStatus,
  summarizeGitStatus,
  filterFilesByGitStatus,
  createGitStatusFilterPredicate,
} from "../src/gitStatusResolver.js";

describe("parseGitStatusPorcelain", () => {
  it("handles empty or whitespace-only git output gracefully", () => {
    expect(parseGitStatusPorcelain("")).toEqual([]);
    expect(parseGitStatusPorcelain("   \n\n  ")).toEqual([]);
  });

  it("parses staged and unstaged modified files correctly", () => {
    const raw = [
      "M  src/stagedOnly.ts",
      " M src/unstagedOnly.ts",
      "MM src/bothStagedAndUnstaged.ts",
    ].join("\n");

    const entries = parseGitStatusPorcelain(raw);
    expect(entries).toHaveLength(3);

    expect(entries[0]).toEqual({
      path: "src/stagedOnly.ts",
      originalPath: undefined,
      indexStatus: "M",
      worktreeStatus: " ",
      isStaged: true,
      isUnstaged: false,
      isUntracked: false,
      isConflicted: false,
      isDeleted: false,
    });

    expect(entries[1].isStaged).toBe(false);
    expect(entries[1].isUnstaged).toBe(true);

    expect(entries[2].isStaged).toBe(true);
    expect(entries[2].isUnstaged).toBe(true);
  });

  it("parses untracked and newly added files", () => {
    const raw = [
      "A  packages/core/src/newFeature.ts",
      "?? packages/core/tests/newFeature.test.ts",
    ].join("\n");

    const entries = parseGitStatusPorcelain(raw);
    expect(entries[0].indexStatus).toBe("A");
    expect(entries[0].isStaged).toBe(true);
    expect(entries[0].isUntracked).toBe(false);

    expect(entries[1].indexStatus).toBe("?");
    expect(entries[1].worktreeStatus).toBe("?");
    expect(entries[1].isUntracked).toBe(true);
    expect(entries[1].isStaged).toBe(false);
  });

  it("parses renamed and quoted file paths", () => {
    const raw = [
      "R  legacy/old-name.ts -> src/renamed.ts",
      '?? "docs/spec folder/notes.md"',
    ].join("\n");

    const entries = parseGitStatusPorcelain(raw);
    expect(entries[0].originalPath).toBe("legacy/old-name.ts");
    expect(entries[0].path).toBe("src/renamed.ts");
    expect(entries[0].isStaged).toBe(true);

    expect(entries[1].path).toBe("docs/spec folder/notes.md");
    expect(entries[1].isUntracked).toBe(true);
  });

  it("parses NUL-delimited paths without trimming, unquoting, or arrow splitting", () => {
    const raw = [
      "M  docs/spec folder/notes.md",
      "?? src/日本語/ファイル.ts",
      "R  src/new -> name.ts",
      "src/old -> name.ts",
      "?? line\nbreak.ts",
      "",
    ].join("\0");

    const entries = parseGitStatusPorcelain(raw);

    expect(entries).toHaveLength(4);
    expect(entries[0].path).toBe("docs/spec folder/notes.md");
    expect(entries[1].path).toBe("src/日本語/ファイル.ts");
    expect(entries[1].isUntracked).toBe(true);
    expect(entries[2].path).toBe("src/new -> name.ts");
    expect(entries[2].originalPath).toBe("src/old -> name.ts");
    expect(entries[2].isStaged).toBe(true);
    expect(entries[3].path).toBe("line\nbreak.ts");
    expect(entries[3].isUntracked).toBe(true);
  });

  it("preserves leading and trailing spaces in NUL-delimited paths", () => {
    const entries = parseGitStatusPorcelain("??  spaced name.ts \0");

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(" spaced name.ts ");
  });

  it("parses copied paths from NUL-delimited records", () => {
    const entries = parseGitStatusPorcelain("C  src/copied.ts\0src/source.ts\0");

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("src/copied.ts");
    expect(entries[0].originalPath).toBe("src/source.ts");
    expect(entries[0].indexStatus).toBe("C");
  });

  it("parses deleted and conflicted files", () => {
    const raw = [
      "D  deprecated/file.ts",
      " D uncommitted-deletion.ts",
      "UU src/mergeConflict.ts",
    ].join("\n");

    const entries = parseGitStatusPorcelain(raw);
    expect(entries[0].isDeleted).toBe(true);
    expect(entries[0].isStaged).toBe(true);

    expect(entries[1].isDeleted).toBe(true);
    expect(entries[1].isUnstaged).toBe(true);

    expect(entries[2].isConflicted).toBe(true);
    expect(entries[2].isStaged).toBe(false);
    expect(entries[2].isUnstaged).toBe(false);
  });
});

describe("summarizeGitStatus", () => {
  it("computes counts and lists for all dirty file categories", () => {
    const raw = [
      "M  staged1.ts",
      "A  staged2.ts",
      " M unstaged1.ts",
      "?? untracked1.ts",
      "UU conflict1.ts",
      "D  deleted1.ts",
    ].join("\n");

    const entries = parseGitStatusPorcelain(raw);
    const summary = summarizeGitStatus(entries);

    expect(summary.totalDirtyCount).toBe(6);
    expect(summary.stagedFiles).toEqual(["staged1.ts", "staged2.ts", "deleted1.ts"]);
    expect(summary.unstagedFiles).toEqual(["unstaged1.ts"]);
    expect(summary.untrackedFiles).toEqual(["untracked1.ts"]);
    expect(summary.conflictedFiles).toEqual(["conflict1.ts"]);
    expect(summary.deletedFiles).toEqual(["deleted1.ts"]);
  });
});

describe("filterFilesByGitStatus", () => {
  const sampleRaw = [
    "M  staged.ts",
    " M unstaged.ts",
    "?? untracked.ts",
    "UU conflict.ts",
    "D  deleted.ts",
  ].join("\n");
  const entries = parseGitStatusPorcelain(sampleRaw);

  it("filters staged files excluding deleted by default", () => {
    const result = filterFilesByGitStatus(entries, "staged", false);
    expect(result).toEqual(["staged.ts"]);
  });

  it("filters staged files including deleted when requested", () => {
    const result = filterFilesByGitStatus(entries, "staged", true);
    expect(result).toEqual(["staged.ts", "deleted.ts"]);
  });

  it("filters unstaged files", () => {
    const result = filterFilesByGitStatus(entries, "unstaged");
    expect(result).toEqual(["unstaged.ts"]);
  });

  it("filters untracked files", () => {
    const result = filterFilesByGitStatus(entries, "untracked");
    expect(result).toEqual(["untracked.ts"]);
  });

  it("filters conflicted files", () => {
    const result = filterFilesByGitStatus(entries, "conflicted");
    expect(result).toEqual(["conflict.ts"]);
  });

  it("filters all dirty files excluding deleted", () => {
    const result = filterFilesByGitStatus(entries, "all-dirty", false);
    expect(result).toEqual(["staged.ts", "unstaged.ts", "untracked.ts", "conflict.ts"]);
  });
});

describe("resolveGitStatus", () => {
  it.skipIf(process.platform === "win32")(
    "requests NUL-delimited porcelain output from git",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "tcalc-fake-git-"));
      const fakeGit = path.join(directory, "git");

      try {
        await writeFile(
          fakeGit,
          [
            "#!/bin/sh",
            '[ "$3" = "-z" ] || exit 3',
            "printf 'M  src/Foo.ts\\000'",
            "",
          ].join("\n"),
        );
        await chmod(fakeGit, 0o755);

        const summary = await resolveGitStatus({
          cwd: directory,
          gitExecutable: fakeGit,
        });

        expect(summary.entries).toHaveLength(1);
        expect(summary.entries[0].path).toBe("src/Foo.ts");
        expect(summary.stagedFiles).toEqual(["src/Foo.ts"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("createGitStatusFilterPredicate", () => {
  it("matches candidate paths against dirty files regardless of Windows/POSIX slashes", () => {
    const entries = parseGitStatusPorcelain("M  src/core/model.ts\n?? tests/integration.test.ts");
    const matcher = createGitStatusFilterPredicate(entries, "all-dirty");

    expect(matcher("src/core/model.ts")).toBe(true);
    expect(matcher("src\\core\\model.ts")).toBe(true);
    expect(matcher("tests/integration.test.ts")).toBe(true);
    expect(matcher("src/unrelated/other.ts")).toBe(false);
  });

  it("supports workspace root relative path resolution", () => {
    const entries = parseGitStatusPorcelain("M  packages/scanner/src/scan.ts");
    const matcher = createGitStatusFilterPredicate(
      entries,
      "staged",
      "C:/repo/project",
    );

    expect(matcher("C:/repo/project/packages/scanner/src/scan.ts")).toBe(true);
    expect(matcher("C:/repo/project/packages/other/src/index.ts")).toBe(false);
  });

  it("only matches path suffixes on segment boundaries", () => {
    const entries = parseGitStatusPorcelain("M  a.ts\nM  packages/scanner/src/scan.ts");
    const matcher = createGitStatusFilterPredicate(entries, "all-dirty");

    expect(matcher("a.ts")).toBe(true);
    expect(matcher("data.ts")).toBe(false);
    expect(matcher("src/data.ts")).toBe(false);
    expect(matcher("src/scan.ts")).toBe(true);
    expect(matcher("rescan.ts")).toBe(false);
  });

  it("does not treat the workspace root itself as a dirty file", () => {
    const entries = parseGitStatusPorcelain("M  packages/scanner/src/scan.ts");
    const matcher = createGitStatusFilterPredicate(entries, "all-dirty", "/repo/project");

    expect(matcher("/repo/project")).toBe(false);
    expect(matcher("/repo/project/packages/scanner/src/scan.ts")).toBe(true);
  });
});
