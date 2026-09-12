#!/bin/bash
# scripts/watchdog.sh — 24/7 Self-Healing Watchdog for ProPCB Portal
# Run via cron every 2 minutes to ensure the app is always responding.

HEALTH_URL="http://127.0.0.1:3000/api/health"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="/var/log/propcb-watchdog.log"

STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")

if [ "$STATUS_CODE" != "200" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HEALTH CHECK FAILED (HTTP $STATUS_CODE). Restarting app container..." >> "$LOG_FILE"
    cd "$APP_DIR" || exit 1
    docker compose -f docker-compose.prod.yml restart app >> "$LOG_FILE" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restart command executed." >> "$LOG_FILE"
fi
