#!/usr/bin/env bash
# ==============================================================================
# ProPCB Portal — Production Server Bootstrap Script (Ubuntu 22.04 / 24.04 LTS)
# This script configures swap, Docker, systemd autostart, and health watchdog.
# ==============================================================================

set -euo pipefail

echo "========================================================"
echo " Starting ProPCB 24/7 Server Setup on AWS EC2..."
echo "========================================================"

if [ "$EUID" -ne 0 ]; then
  echo "Error: Please run this script with sudo: sudo ./scripts/setup-server.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ------------------------------------------------------------------------------
# 1. Configure 4GB Swap (Fixes Out-Of-Memory Crashes)
# ------------------------------------------------------------------------------
if [ ! -f /swapfile ]; then
    echo "[1/6] Creating 4GB swap space to prevent memory crashes..."
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl vm.swappiness=10
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "Swap created successfully:"
    free -h
else
    echo "[1/6] Swapfile already exists. Skipping."
fi

# ------------------------------------------------------------------------------
# 2. Install Packages & Docker
# ------------------------------------------------------------------------------
echo "[2/6] Installing dependencies (Docker, Nginx, Certbot)..."
apt-get update -y
apt-get install -y curl git ufw nginx certbot python3-certbot-nginx ca-certificates gnupg

if ! command -v docker &> /dev/null; then
    echo "Installing Docker Engine..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    usermod -aG docker ubuntu 2>/dev/null || true
    systemctl enable docker
    systemctl start docker
fi

# ------------------------------------------------------------------------------
# 3. Configure Firewall (UFW)
# ------------------------------------------------------------------------------
echo "[3/6] Setting up firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ------------------------------------------------------------------------------
# 4. Create Systemd Service for Auto-Restart on Server Reboot
# ------------------------------------------------------------------------------
echo "[4/6] Creating systemd service for 100% autostart on reboot..."
cat <<EOF > /etc/systemd/system/propcb.service
[Unit]
Description=ProPCB Portal Web Application
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${PROJECT_DIR}
ExecStart=/usr/bin/docker compose -f ${PROJECT_DIR}/docker-compose.prod.yml up -d
ExecStop=/usr/bin/docker compose -f ${PROJECT_DIR}/docker-compose.prod.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable propcb.service

# ------------------------------------------------------------------------------
# 5. Set Up Watchdog Auto-Healer Cron Job
# ------------------------------------------------------------------------------
echo "[5/6] Setting up self-healing watchdog cron job..."
chmod +x "${PROJECT_DIR}/scripts/watchdog.sh"

WATCHDOG_LINE="*/2 * * * * ${PROJECT_DIR}/scripts/watchdog.sh"
(crontab -l 2>/dev/null | grep -v "watchdog.sh" ; echo "$WATCHDOG_LINE") | crontab -

# ------------------------------------------------------------------------------
# 6. Summary
# ------------------------------------------------------------------------------
echo "========================================================"
echo " Setup Completed Successfully!"
echo " - 4GB Swap enabled (No more OOM freeze)"
echo " - Systemd service enabled (Auto-start on AWS reboot)"
echo " - Self-healing watchdog running every 2 minutes"
echo ""
echo "Next step: Run 'docker compose -f docker-compose.prod.yml up -d --build'"
echo "========================================================"
