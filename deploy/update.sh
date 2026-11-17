#!/usr/bin/env bash
# Update a deployed viewer: pull, install dependencies, migrate the users DB, restart.
#
# Usage, on the server:  deploy/update.sh [BRANCH]
#   BRANCH   defaults to the checked-out branch
#   REMOTE   env var, defaults to origin. For a private repo without stored credentials, pass the
#            token URL here, e.g. REMOTE="https://USER:TOKEN@github.com/OWNER/REPO.git"
#            (prefix the command with a space so it stays out of the shell history).
#   SERVICE  env var, the systemd unit name, defaults to viewer
set -euo pipefail

cd "$(dirname "$0")/.."
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
REMOTE="${REMOTE:-origin}"
SERVICE="${SERVICE:-viewer}"

git pull --ff-only "$REMOTE" "$BRANCH"
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m alembic upgrade head
sudo systemctl restart "$SERVICE"

sleep 2
systemctl --no-pager --lines=5 status "$SERVICE"
