#!/bin/bash
# Deploy to the Vultr VM: push code, pull there, rebuild the API, build + upload the dashboard.
#   ./deploy/deploy.sh            # everything
#   ./deploy/deploy.sh dashboard  # dashboard only (fast, ~20 s)
#   ./deploy/deploy.sh api        # backend only
set -euo pipefail
VM=${VM:-root@216.128.184.212}
DIR=${DIR:-super-fire-project}
cd "$(dirname "$0")/.."
what=${1:-all}

BRANCH=$(git branch --show-current)
if [[ $what == all || $what == api ]]; then
  # The VM tracks whatever branch is checked out here, so a feature branch can be deployed as-is.
  git push -u origin "$BRANCH" 2>&1 | grep -vE "moved|new location|^remote:\s*$|^branch|^To |up to date" || true
  ssh "$VM" "cd ~/$DIR && git fetch -q origin && git checkout -q $BRANCH 2>/dev/null || git checkout -q -b $BRANCH origin/$BRANCH; git reset -q --hard origin/$BRANCH && echo VM on \$(git branch --show-current) \$(git rev-parse --short HEAD) && docker compose up -d --build api 2>&1 | tail -1"
fi
if [[ $what == all || $what == dashboard ]]; then
  (cd dashboard && npm run build 2>&1 | grep -E "built in|error" )
  rsync -az --delete dashboard/dist/ "$VM:~/$DIR/dashboard/dist/"
fi
echo "health: $(curl -s -m 8 http://${VM#*@}/api/health | head -c 160)"
