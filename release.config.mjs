export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { breaking: true, release: "major" },
          { revert: true, release: false },
          { type: "feat", release: "patch" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
      },
    ],
    [
      "semantic-release-vsce",
      {
        packageVsix: true,
        publish: true,
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "*.vsix",
            label: "Alembic Graph <%= nextRelease.gitTag %> VSIX",
          },
        ],
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
