/**
 * Thin wrapper around the `acquireVsCodeApi()` global (declared in ../vscode-webview.d.ts).
 * `acquireVsCodeApi()` throws if called more than once per webview, so this module calls it
 * exactly once at module scope — every webview entry must import this module (not call the
 * global directly) to stay safe under bundling/HMR.
 */
import type { HostToWebviewMessage, WebviewToHostMessage } from "../../protocol/messages";

const vscodeApi = acquireVsCodeApi();

/** Sends a typed message from the webview to the extension host. */
export function post(msg: WebviewToHostMessage): void {
  vscodeApi.postMessage(msg);
}

/** Subscribes to typed messages posted by the extension host. */
export function onMessage(handler: (msg: HostToWebviewMessage) => void): void {
  window.addEventListener("message", (event: MessageEvent) => {
    handler(event.data as HostToWebviewMessage);
  });
}

/** Reads webview state persisted via `setPersisted` (survives tab hide/reload). */
export function getPersisted<T>(): T | undefined {
  return vscodeApi.getState() as T | undefined;
}

/** Persists webview state across tab hide/reload (e.g. for `retainContextWhenHidden`-adjacent use). */
export function setPersisted<T>(state: T): void {
  vscodeApi.setState(state);
}
