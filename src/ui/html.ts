/**
 * Builds the HTML document loaded into a webview. Host-side only (uses node:crypto for the CSP
 * nonce) — never imported from src/webview/**.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Full HTML5 document for a webview entry bundle (`dist/webview/${entry}.{js,css}`). */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  entry: "graph" | "sidebar",
  title: string,
): string {
  const nonce = randomBytes(16).toString("base64");
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.css`));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${entry}.js`));
  const csp =
    `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri}">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}
