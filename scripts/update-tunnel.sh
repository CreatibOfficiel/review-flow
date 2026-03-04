#!/bin/bash

# update-tunnel.sh — Start review-flow + ngrok tunnel, update GitLab webhooks if URL changed

set -euo pipefail

PORT=3847
ENV_FILE="$HOME/Library/Application Support/reviewflow/.env"
CACHE_FILE="$HOME/.config/reviewflow/.ngrok-url"
DASHBOARD_URL="http://localhost:$PORT/dashboard/"

# — Colors —
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# — Webhook registry (project_id:hook_id:label) —
WEBHOOKS=(
  "134:6:auguste.video/auguste"
  "158:5:auguste.video/front"
  "108:7:nitro.games/api"
  "109:8:nitro.games/ember"
)

# ──────────────────────────────────────────────
# 1. Ensure review-flow is running
# ──────────────────────────────────────────────
if ! lsof -i :$PORT > /dev/null 2>&1; then
  echo -e "${YELLOW}Starting review-flow...${NC}"
  reviewflow start --skip-dependency-check &
  disown

  for i in {1..30}; do
    if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
      echo -e "${GREEN}review-flow is up${NC}"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "ERROR: review-flow failed to start after 15s" >&2
      exit 1
    fi
    sleep 0.5
  done
else
  echo -e "${DIM}review-flow already running on :$PORT${NC}"
fi

# ──────────────────────────────────────────────
# 2. Ensure ngrok is running
# ──────────────────────────────────────────────
if ! curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
  echo -e "${YELLOW}Starting ngrok...${NC}"
  ngrok http $PORT --log=false &
  disown

  for i in {1..20}; do
    if curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
      echo -e "${GREEN}ngrok is up${NC}"
      break
    fi
    if [ "$i" -eq 20 ]; then
      echo "ERROR: ngrok failed to start after 10s" >&2
      exit 1
    fi
    sleep 0.5
  done
fi

# ──────────────────────────────────────────────
# 3. Get current ngrok URL
# ──────────────────────────────────────────────
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])")

if [ -z "$NGROK_URL" ]; then
  echo "ERROR: could not get ngrok URL" >&2
  exit 1
fi

# ──────────────────────────────────────────────
# 4. Compare with cached URL, update webhooks if changed
# ──────────────────────────────────────────────
mkdir -p "$(dirname "$CACHE_FILE")"
CACHED_URL=""
if [ -f "$CACHE_FILE" ]; then
  CACHED_URL=$(cat "$CACHE_FILE")
fi

if [ "$NGROK_URL" = "$CACHED_URL" ]; then
  echo -e "${DIM}tunnel already up-to-date${NC}"
else
  # Read webhook token from .env
  TOKEN=$(grep '^GITLAB_WEBHOOK_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  if [ -z "$TOKEN" ]; then
    echo "ERROR: GITLAB_WEBHOOK_TOKEN not found in $ENV_FILE" >&2
    exit 1
  fi

  WEBHOOK_URL="${NGROK_URL}/webhooks/gitlab"
  echo -e "${YELLOW}URL changed: updating ${#WEBHOOKS[@]} webhooks → ${WEBHOOK_URL}${NC}"

  for entry in "${WEBHOOKS[@]}"; do
    IFS=: read -r pid hid label <<< "$entry"
    echo -n "  $label ... "
    glab api -X PUT "projects/$pid/hooks/$hid" \
      --hostname gitlab.ascan.io \
      -f "url=$WEBHOOK_URL" \
      -f merge_requests_events=true \
      -f push_events=false \
      -f "token=$TOKEN" \
      -f enable_ssl_verification=true \
      > /dev/null
    echo -e "${GREEN}ok${NC}"
  done

  # Save new URL to cache
  echo "$NGROK_URL" > "$CACHE_FILE"
  echo -e "${GREEN}All webhooks updated${NC}"
fi

# ──────────────────────────────────────────────
# 5. Summary
# ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}ngrok:${NC}     $NGROK_URL"
echo -e "${CYAN}webhook:${NC}   ${NGROK_URL}/webhooks/gitlab"
echo -e "${CYAN}dashboard:${NC} $DASHBOARD_URL"

# Open dashboard
open "$DASHBOARD_URL" 2>/dev/null || true
