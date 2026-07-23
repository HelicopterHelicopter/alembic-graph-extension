# Releasing Alembic Graph

Releases are automated from `main` with
[semantic-release](https://semantic-release.gitbook.io/semantic-release/) and
[semantic-release-vsce](https://github.com/felipecrs/semantic-release-vsce).
Do not manually bump `package.json` or `package-lock.json`: the release job writes the calculated
version only in its temporary workspace.

## One-time repository setup

1. Add an Actions repository secret named `OVSX_PAT` containing an
   [Open VSX access token](https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).
2. Seed semantic-release from the version that is already published:

   ```sh
   git tag v0.0.3 8c6e5723f8e3dd68db6d4c753f1e0ebf62bd623c
   git push origin main
   git push origin v0.0.3
   ```

3. Protect `main`, require pull requests, and require the `Commitlint` status check.

The `v0.0.3` commit must remain in `main` history; do not squash it away when integrating the
automation branch. The release workflow verifies the secret, the baseline tag, and that ancestry
before semantic-release runs.
The automation commit should use a `ci:` subject, so installing the workflow does not republish the
extension.

## Version policy

Pull request commits must follow Conventional Commits. GitHub-generated merge commits are ignored.

- `feat:`, `fix:`, and `perf:` publish the next patch while the project remains on `0.0.x`.
- `build:`, `chore:`, `ci:`, `docs:`, `refactor:`, `revert:`, `style:`, and `test:` do not publish.
- A `BREAKING CHANGE:` footer or `!` marker retains semantic-release's major-release behavior.

For each releasable push, CI checks types and unit tests, builds one universal VSIX, publishes it to
Open VSX, creates the matching `vX.Y.Z` tag and GitHub Release, and attaches the VSIX to that
release. Git tags and GitHub Releases are the release record; `CHANGELOG.md` is retained only as
historical documentation and is not included in new VSIX packages.

## Failed publish recovery

The workflow uploads any generated VSIX for 14 days when a release fails. Before retrying, check
whether the calculated version exists on Open VSX and whether its Git tag or GitHub Release exists.

- If GitHub has a draft or incomplete release, inspect it: attach the recovered VSIX if it is
  missing and publish the release. If it cannot be recovered, remove only that incomplete draft
  before recreating the release from the existing tag. `@semantic-release/github` can leave this
  state when asset upload or release finalization fails.
- If Open VSX has the version but GitHub has no release, create the GitHub Release from the
  existing tag and attach the recovered VSIX.
- If Open VSX does not have the version but semantic-release pushed its tag, either publish the
  recovered VSIX manually and complete the GitHub Release, or delete only that failed release tag
  locally and remotely before rerunning the release workflow.
- If no tag was created, rerun the failed workflow after correcting the reported error.
