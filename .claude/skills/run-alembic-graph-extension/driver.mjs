// Drives a real VS Code Extension Development Host running this repo's extension.
//
//   node .claude/skills/run-alembic-graph-extension/driver.mjs <workspace-path> <out-prefix>
//
// Launches VS Code's own Electron binary with --extensionDevelopmentPath pointed at this
// repo, connects Playwright over CDP (playwright's _electron.launch does NOT work with
// VS Code — see SKILL.md Gotchas), opens the Alembic sidebar, screenshots it, prints the
// status bar + sidebar webview text, opens the Migration Graph panel, screenshots that.
//
// Outputs: <out-prefix>-sidebar.png, <out-prefix>-graph.png, and STATUSBAR:/SIDEBAR_TEXT:
// lines on stdout. Exits non-zero on any failure. Requires playwright-core resolvable from
// the repo (npm install --no-save playwright-core).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VSCODE_BIN = process.env.VSCODE_ELECTRON ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";
const CDP_PORT = Number(process.env.ALX_CDP_PORT ?? 9333);
// Short on purpose: VS Code binds a unix socket inside user-data-dir; a long path
// (e.g. a deep scratch dir) exceeds the ~103-char sun_path limit -> listen EINVAL.
const PROFILE_ROOT = "/private/tmp/alxvsc";

function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      http
        .get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() > deadline) reject(new Error(`CDP endpoint on :${CDP_PORT} never came up`));
          else setTimeout(poll, 500);
        });
    };
    poll();
  });
}

const [, , wsArg, outPrefix] = process.argv;
if (!wsArg || !outPrefix) {
  console.error("usage: node driver.mjs <workspace-path> <out-prefix>");
  process.exit(2);
}

mkdirSync(path.join(PROFILE_ROOT, "ud"), { recursive: true });
mkdirSync(path.join(PROFILE_ROOT, "ext"), { recursive: true });

const child = spawn(
  VSCODE_BIN,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-updates",
    "--disable-workspace-trust",
    "--new-window",
    `--user-data-dir=${path.join(PROFILE_ROOT, "ud")}`,
    `--extensions-dir=${path.join(PROFILE_ROOT, "ext")}`,
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    path.resolve(wsArg),
  ],
  { stdio: "ignore" },
);

try {
  await waitForCdp(30000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

  // The workbench page is one CDP target among several (shared process, webviews, ...).
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes("workbench.html")) page = p;
      }
    }
    if (!page) await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error("workbench page not found over CDP");

  await page.waitForSelector(".monaco-workbench", { timeout: 45000 });
  await page.waitForTimeout(3000);

  await page.locator('.activitybar [aria-label^="Alembic"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(5000); // scan + phase-2 CLI enrichment + webview render
  await page.screenshot({ path: `${outPrefix}-sidebar.png` });

  const status = await page
    .locator(".part.statusbar")
    .innerText({ timeout: 5000 })
    .catch(() => "<no statusbar>");
  console.log("STATUSBAR:", JSON.stringify(status.replace(/\n+/g, " | ")));

  // Best-effort: sidebar webview text through the nested iframes (outer service-worker
  // iframe, then #active-frame). `.last()` because the graph panel, if open, is earlier.
  try {
    const inner = page.frameLocator("iframe.webview.ready").last().frameLocator("#active-frame");
    const text = await inner.locator("body").innerText({ timeout: 5000 });
    console.log("SIDEBAR_TEXT:", JSON.stringify(text.replace(/\n+/g, " | ").slice(0, 500)));
  } catch (e) {
    console.log("SIDEBAR_TEXT: <unavailable>", String(e).split("\n")[0]);
  }

  await page.keyboard.press("Meta+Shift+P");
  await page.waitForTimeout(800);
  await page.keyboard.type("Open Migration Graph", { delay: 30 });
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${outPrefix}-graph.png` });

  console.log("DONE");
} catch (e) {
  console.error("DRIVER FAILED:", String(e).split("\n").slice(0, 3).join(" "));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
