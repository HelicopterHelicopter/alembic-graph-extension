import { describe, expect, it, vi } from "vitest";

const { getExtension } = vi.hoisted(() => ({ getExtension: vi.fn() }));

vi.mock("vscode", () => ({
  extensions: { getExtension },
}));

import { getActivePythonPath } from "../../src/services/pythonEnv";

describe("getActivePythonPath", () => {
  it("scopes the ms-python active environment lookup to the selected project resource", async () => {
    const resource = { fsPath: "/linked/services/api/alembic.ini" };
    const getActiveEnvironmentPath = vi.fn(() => ({ id: "env-id", path: "/selected" }));
    const resolveEnvironment = vi.fn(async () => ({
      executable: { uri: { fsPath: "/selected/bin/python" } },
    }));
    getExtension.mockReturnValue({
      isActive: true,
      exports: { environments: { getActiveEnvironmentPath, resolveEnvironment } },
    });

    await expect(getActivePythonPath(resource as never)).resolves.toBe("/selected/bin/python");
    expect(getActiveEnvironmentPath).toHaveBeenCalledWith(resource);
  });
});
