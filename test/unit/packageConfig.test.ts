import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(here, "../../package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } };
};
const settings = packageJson.contributes.configuration.properties;

describe("worktree runtime settings", () => {
  it("declares resource-scoped environment and Python paths with empty defaults", () => {
    expect(settings["alembicGraph.environmentFile"]).toMatchObject({
      type: "string",
      default: "",
      scope: "resource",
    });
    expect(settings["alembicGraph.pythonEnvironmentPath"]).toMatchObject({
      type: "string",
      default: "",
      scope: "resource",
    });
  });

  it("makes the existing Alembic command override resource-scoped for multi-root workspaces", () => {
    expect(settings["alembicGraph.alembicCommand"]).toMatchObject({ scope: "resource" });
  });
});
