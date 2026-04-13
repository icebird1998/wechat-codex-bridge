#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEXBRIDGE_REPO:-https://github.com/begonia599/CodexBridge.git}"
INSTALL_DIR="${CODEXBRIDGE_DIR:-$HOME/codexbridge}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

detect_package_manager() {
  for pm in apt-get dnf yum pacman; do
    if command_exists "$pm"; then
      PACKAGE_MANAGER="$pm"
      return
    fi
  done
  echo "Unsupported Linux distribution: no apt-get/dnf/yum/pacman found." >&2
  exit 1
}

ensure_git() {
  if command_exists git; then return; fi
  echo "[+] Installing git..."
  case "$PACKAGE_MANAGER" in
    apt-get) sudo apt-get update && sudo apt-get install -y git ;;
    dnf) sudo dnf install -y git ;;
    yum) sudo yum install -y git ;;
    pacman) sudo pacman -Sy --noconfirm git ;;
  esac
}

ensure_node() {
  if command_exists node && command_exists npm; then return; fi
  echo "[+] Installing Node.js..."
  case "$PACKAGE_MANAGER" in
    apt-get)
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo "$PACKAGE_MANAGER" install -y nodejs
      ;;
    pacman)
      sudo pacman -Sy --noconfirm nodejs npm
      ;;
  esac
}

ensure_docker() {
  if command_exists docker; then return; fi
  echo "[+] Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable docker
  sudo systemctl start docker
  if command_exists groupadd && command_exists usermod; then
    sudo usermod -aG docker "$USER"
  fi
}

ensure_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    return
  fi
  if command_exists docker-compose; then
    COMPOSE_CMD="docker-compose"
    return
  fi

  echo "[+] Installing Docker Compose v2..."
  DEST="/usr/local/bin/docker-compose"
  sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.7/docker-compose-$(uname -s)-$(uname -m)" -o "$DEST"
  sudo chmod +x "$DEST"
  COMPOSE_CMD="docker-compose"
}

clone_or_update_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[+] Updating existing repository at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --rebase
  else
    echo "[+] Cloning CodexBridge into $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
}

prepare_env_file() {
  cd "$INSTALL_DIR"
  if [ ! -f .env ]; then
    cp .env.example .env
    echo "[+] Created .env from template. Please edit it with your Codex settings."
  fi
}

bring_up_stack() {
  cd "$INSTALL_DIR"
  echo "[+] Installing npm dependencies..."
  npm install
  echo "[+] Starting CodexBridge via Docker Compose..."
  $COMPOSE_CMD up -d --build
  echo "[+] CodexBridge is running. If this is the first time installing Docker, log out and log in again so your user picks up docker group membership."
}

main() {
  detect_package_manager
  ensure_git
  ensure_node
  ensure_docker
  ensure_docker_compose
  clone_or_update_repo
  prepare_env_file
  bring_up_stack
}

main "$@"
