import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { executeCatalogValidate } from "../src/commands/catalog.js";

const catalog = JSON.parse(
  readFileSync("catalogs/models.json", "utf8"),
) as { updatedAt: string };
const catalogUpdatedAt = new Date(`${catalog.updatedAt}T00:00:00Z`);

describe("catalog validate command", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(catalogUpdatedAt);
  });

  afterAll(() => {
    vi.useRealTimers();
  });
  it("validates valid catalog", async () => {
    // The bundled catalog from the workspace catalogs directory
    const result = await executeCatalogValidate({
      path: "catalogs/models.json",
    });
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("VALID");
  });

  it("emits JSON when requested", async () => {
    const result = await executeCatalogValidate({
      path: "catalogs/models.json",
      format: "json",
    });
    const payload = JSON.parse(result.message);
    expect(payload).toMatchObject({ valid: true, errors: [] });
    expect(payload.modelCount).toBeGreaterThanOrEqual(20);
  });

  it("fails on missing catalog", async () => {
    const result = await executeCatalogValidate({
      path: "catalogs/nonexistent.json",
    });
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("No models found");
  });

  it("reports a catalog older than the freshness limit", async () => {
    vi.setSystemTime(new Date(catalogUpdatedAt.getTime() + 91 * 86_400_000));
    try {
      const result = await executeCatalogValidate({
        path: "catalogs/models.json",
      });
      expect(result.valid).toBe(false);
      expect(result.message).toContain("days old");
    } finally {
      vi.setSystemTime(catalogUpdatedAt);
    }
  });

  it("fails on invalid catalog path", async () => {
    const result = await executeCatalogValidate({
      path: "nonexistent/path/models.json",
    });
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
