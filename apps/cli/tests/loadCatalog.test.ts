import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveBundledCatalogPath,
  resolveCatalog,
} from "../src/utils/loadCatalog.js";

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

async function writeSingleModelCatalog(directory: string): Promise<string> {
  const source = JSON.parse(
    await readFile(path.resolve("catalogs/models.json"), "utf8"),
  ) as { version: string; updatedAt: string; models: unknown[] };
  const catalogPath = path.join(directory, "models.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: source.version,
      updatedAt: source.updatedAt,
      models: source.models.slice(0, 1),
    }),
  );
  return catalogPath;
}

describe("CLI catalog resolution", () => {
  it("loads the bundled catalog for a workspace without a local catalog", async () => {
    const root = await tempDirectory("tcalc-no-catalog-");

    const catalog = resolveCatalog(undefined, root);

    expect(catalog.models.length).toBeGreaterThanOrEqual(20);
  });

  it("prefers an explicit catalog path over the bundled catalog", async () => {
    const root = await tempDirectory("tcalc-explicit-catalog-");
    const catalogPath = await writeSingleModelCatalog(root);

    const catalog = resolveCatalog(catalogPath);

    expect(catalog.models).toHaveLength(1);
  });

  it("prefers a workspace catalog over the bundled catalog", async () => {
    const root = await tempDirectory("tcalc-workspace-catalog-");
    const catalogDir = path.join(root, "catalogs");
    await mkdir(catalogDir);
    await writeSingleModelCatalog(catalogDir);

    const catalog = resolveCatalog(undefined, root);

    expect(catalog.models).toHaveLength(1);
  });

  it("fails clearly when an explicit catalog path does not exist", async () => {
    const root = await tempDirectory("tcalc-missing-catalog-");

    expect(() => resolveCatalog(path.join(root, "missing.json"))).toThrow(
      "Catalog path does not exist",
    );
  });

  it("fails clearly when no bundled catalog exists at any install location", () => {
    const fakeModuleUrl = pathToFileURL(
      path.join(
        tmpdir(),
        "tcalc-no-install",
        "apps",
        "cli",
        "dist",
        "utils",
        "loadCatalog.js",
      ),
    ).href;

    expect(() => resolveBundledCatalogPath(fakeModuleUrl)).toThrow(
      /Bundled model catalog not found/,
    );
  });
});
