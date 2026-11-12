# Release branches and VPS deployment

Push a branch named `release-*` containing these workflow files to run Rust checks, browser regressions, deployment tests, a production Docker build and automatic VPS deployment. Main, other branches, PRs and version tags do not trigger app CI or deployment. Documentation publishing is independent.

```bash
# Start from the application version you intend to ship, including the CI changes.
git switch -c release-20261112
git push -u origin release-20261112
```

The CI workflow calls the browser and release reusable workflows. Only after every check succeeds does it build `browser-control/Dockerfile` for Linux amd64 with `WEB_BASE=/iphone/`. It smoke-tests the resulting container before pushing `ghcr.io/trash-boy/phone-use:sha-<commit>` and deploys the immutable `@sha256:...` reference. Never use the unrelated root `docker/Dockerfile` as the web deployment image.

Runs are serialized under `release-vps-production` without cancelling a running deployment. GitHub concurrency retains at most one pending run; a newer push may replace an older pending run. Active runs finish. A server-side file lock also prevents two CI deploy programs from changing the stack simultaneously.

## Provisioned deployment access

Repository Secrets:

| Secret | Purpose |
| --- | --- |
| `VPS_HOST` | VPS SSH hostname/address |
| `VPS_PORT` | SSH port |
| `VPS_USER` | Existing deployment account |
| `VPS_SSH_KEY` | Dedicated ed25519 private key restricted to this deployment entry point |
| `VPS_KNOWN_HOSTS` | Pinned SSH host public key, obtained over the existing trusted connection |

The `vps-production` GitHub environment allows only branch deployments matching `release-*`. Image publishing uses `GITHUB_TOKEN` with `packages: write`; deployment uses a separate job token with `packages: read`. No personal GHCR token is required. The package is linked to this repository through its OCI source label. Keep the package accessible to this repository's Actions token.

The VPS runs a root-owned copy of `deploy-vps.py` at `/usr/local/libexec/phone-use-deploy-vps.py`. The dedicated public key is appended to the deployment user's `authorized_keys` with `restrict` and a forced command:

```text
restrict,command="sudo -n /usr/bin/python3 -I /usr/local/libexec/phone-use-deploy-vps.py" ssh-ed25519 <public-key> phone-use-github-actions-deploy
```

The deployment account must already be permitted to invoke that command through noninteractive sudo. The key does not permit an interactive shell, forwarding, a PTY, SCP or arbitrary remote commands. The entry point reads JSON on stdin and accepts only a `release-*` branch, a commit SHA, an Actions run identity and this repository's image digest. Its GHCR token is used through a temporary Docker config that is removed after pull. Never place real keys, tokens or server environment files in Git.

When updating `deploy-vps.py`, also update the root-owned server copy over the administrator connection after reviewing and testing it. The release job deliberately cannot replace its own privileged entry point.

## Deployment and rollback

The server preserves `/opt/stacks/iphone-control/compose.yaml`, `.env`, environment overrides, the runtime bind mount, Nginx, resource limits and log settings. It replaces only the single control image reference, verifies the OCI revision and running image ID, and checks local/public HTML, config JSON and rejection of unauthenticated session creation. It never creates a phone session or executes phone actions during health checks.

Before restart, it saves the previous Compose and deployment record under `/opt/stacks/iphone-control/ci-deployments/<run-id>-<attempt>/`. Restart or health failure restores the previous Compose and restarts the previous service. Rollback failure is reported as a failure requiring administrator attention. An application restart disconnects active browser/phone sessions; signing state and runtime data remain mounted.

Successful deployment records the source branch, commit, exact image, previous image, timestamp and rollback path in `/opt/stacks/iphone-control/deployment.json`. Actions also prints this record without credentials. Images are not pruned automatically, so the prior image remains available for rollback.

For manual rollback, use the administrator connection and restore the `compose.before.yaml` named by the deployment record, then run:

```bash
sudo docker compose -f /opt/stacks/iphone-control/compose.yaml config --quiet
sudo docker compose -f /opt/stacks/iphone-control/compose.yaml up -d --no-build --pull never control
```

Avoid deploying concurrently through another administrator tool. CI detects Compose changes during its image pull and aborts rather than overwriting them. Manual deployment tooling should honor the same `.ci-deploy.lock` file.

## Validation

```bash
python3 -m unittest discover -s deploy/tests -v
actionlint
bash -n deploy/smoke-image.sh
```

Tests cover successful deployment, preservation of configuration/environment, exact revision checks, input rejection, concurrent config changes, failed-health rollback and rollback failure. HTTP smoke checks establish server availability and basic authentication; physical iPhone, WDA and model behavior require separate verification.

Initial setup intentionally does not create a release branch or change the running application. Merge these configuration changes before creating your first release branch; when releasing from an existing feature branch, merge or cherry-pick the CI changes there as well.
