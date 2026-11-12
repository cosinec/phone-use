# Release branch CI and VPS deployment

Only pushes to branches matching `release-*` run the CI, browser build, image packaging and VPS deployment. Pull requests, other branches and tags do not trigger those workflows. Existing documentation publishing remains separate.

Reuse the repository's Rust checks and browser regression workflow. After all checks pass, GitHub builds `browser-control/Dockerfile` for the VPS's Linux amd64 platform with `WEB_BASE=/iphone/`, runs an HTTP smoke check, and pushes an immutable commit-tagged image to `ghcr.io/trash-boy/phone-use`. Deploy by digest, with OCI revision/source labels.

VPS deployment preserves `/opt/stacks/iphone-control/compose.yaml`, `.env`, runtime bind mount, Nginx and logging configuration. The deploy program changes only the control service's image reference. It backs up the compose file and deployment record, checks the image revision, restarts the service and checks local/public HTTP plus authentication. Failure restores the prior compose file and service, and returns failure to Actions. Deployment uses a server-side file lock and workflow concurrency to serialize changes.

A dedicated SSH key is stored as a GitHub Secret and restricted in authorized_keys to a root-owned deployment entry point. SSH host keys are pinned. The entry point validates the image repository/digest, commit, branch and run ID. The job's short-lived GitHub token authenticates GHCR using a temporary Docker configuration; credentials are never committed or printed. The existing server environment and signing data remain on the server.

This change is prepared on `codex/release-vps-ci`, based on `origin/main`, without publishing or redeploying another task's source changes. The first release source must be selected separately because main is older than the current VPS deployment. Runtime smoke checks establish server availability, not physical iPhone operation.

Validation covers workflow syntax, non-release trigger exclusion, successful deployment, rollback after failed health checks, rollback failure reporting, input rejection, compose/config preservation and SSH key restrictions. The first real image build/deploy is run only from a user-selected release branch.
