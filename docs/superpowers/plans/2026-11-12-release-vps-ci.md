# Release branch CI and VPS deployment implementation plan

**Goal:** Build release branches in GitHub and deploy immutable images to the existing VPS.

**Architecture:** Reuse Rust and browser checks, call a reusable image/deploy workflow after all checks pass, and invoke a restricted VPS deployment program over SSH. Preserve server configuration and roll back on failed checks.

**Tech stack:** GitHub Actions, Docker Buildx/GHCR/Compose, Python standard library, OpenSSH.

## Constraints

- Trigger only on push to `release-*`; do not deploy PRs, main or tags.
- Image repository: `ghcr.io/trash-boy/phone-use`; platform: `linux/amd64`; web base: `/iphone/`.
- Preserve existing VPS environment, mount and proxy configuration.
- Never publish another task's commits or replace the running version just to test the workflow.

## Tasks

- [ ] Add `deploy/deploy-vps.py` and behavioral tests under `deploy/tests/`. Validate inputs before side effects, replace exactly one image reference, back up, deploy, health check, roll back, record revision and digest. Run `python3 -m unittest discover -s deploy/tests -v`.
- [ ] Change `.github/workflows/ci.yml` to release-only pushes and serialize runs. Reuse `.github/workflows/browser.yml` through `workflow_call`. Replace upstream tag release workflow with a reusable `.github/workflows/release.yml` that builds/smokes/pushes the web image and deploys its digest. Run actionlint and `git diff --check`.
- [ ] Install the root-owned deploy entry point and a dedicated forced-command SSH key without restarting the service. Set repository Secrets via stdin, validate key restrictions and reject invalid deploy requests, and verify the active container is unchanged.
- [ ] Document setup, release commands, rollback and verification limits in `deploy/README.md`. Commit and push only this change and open a reviewable PR. Run live packaging/deployment only after the first release source is selected.
