/**
 * Resolves the active Python interpreter path via the ms-python extension, when it's installed.
 * Best-effort only: the ms-python extension's exported API shape has drifted across versions and
 * isn't published as a types package, so every property access below is guarded and any
 * throw/unexpected shape collapses to `null` rather than surfacing an error. Callers (alembicCli's
 * `resolve`) treat `null` the same as "no interpreter known" and fall back to a bare `alembic` on
 * PATH — this function must never be the reason the extension fails to activate or a refresh fails.
 */
import * as vscode from "vscode";

interface ResolvedPythonEnvironment {
  executable?: { uri?: vscode.Uri };
}

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath?(resource?: vscode.Uri): { id: string; path: string } | undefined;
    resolveEnvironment?(
      env: { id: string; path: string } | string,
    ): Promise<ResolvedPythonEnvironment | undefined>;
  };
}

/** Active interpreter path via the ms-python extension, or null. Never throws. */
export async function getActivePythonPath(): Promise<string | null> {
  try {
    const ext = vscode.extensions.getExtension<PythonExtensionApi>("ms-python.python");
    if (ext === undefined) return null;

    const api = ext.isActive ? ext.exports : await ext.activate();
    const environments = api?.environments;
    if (environments === undefined) return null;

    const activeEnv = environments.getActiveEnvironmentPath?.();
    if (activeEnv === undefined) return null;

    const resolved = await environments.resolveEnvironment?.(activeEnv);
    const fsPath = resolved?.executable?.uri?.fsPath;
    return typeof fsPath === "string" && fsPath.length > 0 ? fsPath : null;
  } catch {
    return null;
  }
}
