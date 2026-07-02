import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const prod = process.argv.includes("--production");

/** Emits esbuild diagnostics in a format the VS Code problem matcher understands. */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log("[watch] build finished");
    });
  },
};

const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: !prod,
  minify: prod,
  plugins: [problemMatcherPlugin],
});

const webviewCtx = await esbuild.context({
  entryPoints: {
    "webview/graph": "src/webview/graph/main.ts",
    "webview/sidebar": "src/webview/sidebar/main.ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outdir: "dist",
  sourcemap: !prod,
  minify: prod,
  plugins: [problemMatcherPlugin],
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
