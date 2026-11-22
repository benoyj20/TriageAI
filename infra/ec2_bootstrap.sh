#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 EC2 instance. Run as the default `ubuntu` user:
#   curl -fsSL https://raw.githubusercontent.com/Dogtags27/gdg-sentinal/main/infra/ec2_bootstrap.sh | bash
# or copy it over and `bash ec2_bootstrap.sh`.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Dogtags27/gdg-sentinal.git}"
APP_DIR="${APP_DIR:-/opt/sentineldesk}"

echo "== packages"
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates python3 fail2ban unattended-upgrades >/dev/null

echo "== docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
sudo usermod -aG docker "$USER"

echo "== swap (headroom for image builds on small instances)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== ssh hardening (port 22 is open to all, so keys only + fail2ban)"
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd
sudo systemctl enable --now fail2ban >/dev/null

echo "== code"
sudo mkdir -p "$APP_DIR" && sudo chown "$USER:$USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone -q "$REPO_URL" "$APP_DIR"
fi

echo "Done. Next: put .env in $APP_DIR (never in git), then: cd $APP_DIR && sg docker -c ./infra/deploy.sh"
