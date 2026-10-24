import { loadModelCatalog, validateModelCatalog } from "@wma/model-catalog";
import type { ModelCatalog } from "@wma/core";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCatalogInWorkspace } from "./paths.js";
import { CliError } from "./errors.js";

export function resolveCatalog(catalogPath?: string, rootPath?: string): ModelCatalog {
  if (catalogPath) {
    if (!existsSync(catalogPath)) throw new CliError(`Catalog path does not exist: ${catalogPath}`);
    return validateLoadedCatalog(loadModelCatalog(catalogPath), catalogPath);
  }
  if (rootPath) {
    const candidates = findCatalogInWorkspace(rootPath);
    for (const cp of candidates) {
      const cat = loadModelCatalog(cp);
      if (cat.models.length > 0) return validateLoadedCatalog(cat, cp);
    }
  }
  const bundledPath = resolveBundledCatalogPath();
  return validateLoadedCatalog(
    loadModelCatalog(bundledPath, { strict: true }),
    bundledPath,
  );
}

export function bundledCatalogCandidates(moduleUrl: string = import.meta.url): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "../../catalogs/models.json"),
    path.resolve(moduleDir, "../catalogs/models.json"),
    path.resolve(moduleDir, "../../../catalogs/models.json"),
    path.resolve(moduleDir, "../../../../catalogs/models.json"),
  ];
  return [...new Set(candidates)];
}

export function resolveBundledCatalogPath(moduleUrl: string = import.meta.url): string {
  const candidates = bundledCatalogCandidates(moduleUrl);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliError(
      `Bundled model catalog not found. Looked in: ${candidates.join(", ")}. Reinstall @wma/cli or pass --catalog.`,
    );
  }
  return found;
}

function validateLoadedCatalog(catalog: ModelCatalog, source: string): ModelCatalog {
  const errors = validateModelCatalog(catalog.models);
  if (errors.length > 0) throw new CliError(`Invalid model catalog at ${source}: ${errors[0]}`);
  return catalog;
}
