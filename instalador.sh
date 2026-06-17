#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_URL="${ZAI_PROXY_REMOTE_URL:-https://github.com/AnThophicous/zaiproxy.git}"
REMOTE_BRANCH="${ZAI_PROXY_REMOTE_BRANCH:-main}"
REMOTE_REF="refs/remotes/zai-proxy-updater/${REMOTE_BRANCH}"
BASE_URL="${ZAI_PROXY_BASE_URL:-http://127.0.0.1:${PORT:-3000}/v1}"
MODEL="${ZAI_PROXY_MODEL:-GLM-5.2}"
SMALL_MODEL="${ZAI_PROXY_SMALL_MODEL:-GLM-5-Turbo}"
CONFIG_DIR="$HOME/.config/zai-proxy"
ENV_FILE="$CONFIG_DIR/env"
STAMP="$(date +%Y%m%d-%H%M%S)"
VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$ROOT_DIR/package.json" 2>/dev/null || sed -n 's/.*\"version\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' "$ROOT_DIR/package.json" | head -1)"
APP_NAME="ZAI Proxy ${VERSION:-0.0.0}"

CLIENT_IDS=()
CLIENT_NAMES=()

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""
fi

say() { printf '%s\n' "$*"; }
info() { say "${C_BLUE}[INFO]${C_RESET} $*"; }
ok() { say "${C_GREEN}[ OK ]${C_RESET} $*"; }
warn() { say "${C_YELLOW}[WARN]${C_RESET} $*"; }
fail() { say "${C_RED}[FAIL]${C_RESET} $*"; }
has_cmd() { command -v "$1" >/dev/null 2>&1; }

box() {
  local title="$1"
  say "${C_BOLD}+------------------------------------------------------------+${C_RESET}"
  printf "${C_BOLD}| %-58s |${C_RESET}\n" "$title"
  say "${C_BOLD}+------------------------------------------------------------+${C_RESET}"
}

run_with_progress() {
  local label="$1"
  shift
  printf "%s " "$label"
  "$@" >/tmp/zai-proxy-installer.$$ 2>&1 &
  local pid=$!
  local frames='/-\|'
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r%s [%c] %02d%%" "$label" "${frames:i++%4:1}" "$(( (i * 7) % 97 ))"
    sleep 0.08
  done
  if wait "$pid"; then
    printf "\r%s [#] 100%%\n" "$label"
    rm -f /tmp/zai-proxy-installer.$$
    return 0
  fi
  printf "\r%s [!] failed\n" "$label"
  cat /tmp/zai-proxy-installer.$$ >&2 || true
  rm -f /tmp/zai-proxy-installer.$$
  return 1
}

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  case "${answer,,}" in
    y|yes|s|sim) return 0 ;;
    *) return 1 ;;
  esac
}

project_header() {
  clear 2>/dev/null || true
  box "$APP_NAME installer"
  say "  Source : $REMOTE_URL"
  say "  Branch : $REMOTE_BRANCH"
  say "  Base   : $BASE_URL"
  say "  Model  : $MODEL"
  say ""
}

maybe_update_self() {
  [ "${ZAI_PROXY_SKIP_UPDATE:-0}" = "1" ] && return 0
  if ! has_cmd git || [ ! -d "$ROOT_DIR/.git" ]; then
    warn "Git repo nao detectado; updater ignorado."
    return 0
  fi

  box "Updater"
  info "Verificando $REMOTE_URL ($REMOTE_BRANCH)"
  run_with_progress "Fetching remote" git -C "$ROOT_DIR" fetch --quiet "$REMOTE_URL" "${REMOTE_BRANCH}:${REMOTE_REF}" || {
    warn "Nao foi possivel consultar o GitHub. Continuando com a versao local."
    return 0
  }

  local current remote behind ahead
  current="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  remote="$(git -C "$ROOT_DIR" rev-parse --short "$REMOTE_REF")"
  behind="$(git -C "$ROOT_DIR" rev-list --count "HEAD..$REMOTE_REF" 2>/dev/null || printf '0')"
  ahead="$(git -C "$ROOT_DIR" rev-list --count "$REMOTE_REF..HEAD" 2>/dev/null || printf '0')"

  say "  Local : $current"
  say "  Remote: $remote"
  say "  Behind: $behind commit(s)"
  say "  Ahead : $ahead commit(s)"

  if [ "$behind" -eq 0 ]; then
    ok "ZAI Proxy esta atualizado."
    return 0
  fi

  say ""
  git -C "$ROOT_DIR" --no-pager log --oneline --decorate --max-count=8 "HEAD..$REMOTE_REF" || true
  say ""

  local should_update=0
  if [ "$behind" -gt 5 ]; then
    warn "Instalacao mais de 5 commits atrasada. Atualizacao automatica obrigatoria."
    should_update=1
  elif confirm "Atualizar agora para $remote?"; then
    should_update=1
  fi

  [ "$should_update" -eq 1 ] || return 0

  local stash_name=""
  if ! git -C "$ROOT_DIR" diff --quiet || [ -n "$(git -C "$ROOT_DIR" ls-files --others --exclude-standard)" ]; then
    stash_name="zai-proxy-installer-$STAMP"
    warn "Worktree suja; criando stash temporario: $stash_name"
    git -C "$ROOT_DIR" stash push -u -m "$stash_name" >/dev/null
  fi

  run_with_progress "Fast-forward update" git -C "$ROOT_DIR" merge --ff-only "$REMOTE_REF" || {
    fail "Update falhou. O repo pode estar divergente; nada destrutivo foi executado."
    [ -n "$stash_name" ] && git -C "$ROOT_DIR" stash pop >/dev/null || true
    return 1
  }

  if [ -n "$stash_name" ]; then
    warn "Reaplicando stash temporario."
    git -C "$ROOT_DIR" stash pop >/dev/null || warn "Stash nao reaplicou limpo; resolva manualmente com git stash list."
  fi

  ok "Atualizado para $(git -C "$ROOT_DIR" rev-parse --short HEAD)."
  if [ -x "$ROOT_DIR/instalador.sh" ]; then
    info "Reiniciando instalador atualizado."
    exec env ZAI_PROXY_SKIP_UPDATE=1 "$ROOT_DIR/instalador.sh"
  fi
}

add_client() {
  CLIENT_IDS+=("$1")
  CLIENT_NAMES+=("$2")
}

detect_clients() {
  CLIENT_IDS=()
  CLIENT_NAMES=()
  if has_cmd zed || [ -e "$HOME/.config/zed/settings.json" ]; then add_client "zed" "Zed"; fi
  if has_cmd codex || [ -e "$HOME/.codex/config.toml" ]; then add_client "codex" "OpenAI Codex CLI"; fi
  if has_cmd opencode || [ -e "$HOME/.config/opencode/opencode.jsonc" ]; then add_client "opencode" "OpenCode"; fi
  if has_cmd aider || [ -e "$HOME/.aider.conf.yml" ]; then add_client "aider" "Aider/OpenAI env"; fi
  if has_cmd claude || has_cmd claude-code; then add_client "claude" "Claude Code (note only)"; fi
}

backup_file() {
  local path="$1"
  if [ -f "$path" ]; then
    cp "$path" "$path.bak.$STAMP"
    info "Backup: $path.bak.$STAMP"
  fi
}

append_env_if_missing() {
  local path="$1" key="$2" value="$3"
  mkdir -p "$(dirname "$path")"
  touch "$path"
  if ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$path"; then
    printf '\nexport %s=%q\n' "$key" "$value" >> "$path"
  fi
}

prepare_proxy() {
  box "Runtime"
  cd "$ROOT_DIR"
  append_env_if_missing "$ROOT_DIR/.env" "ZAI_DEFAULT_MODEL" "$MODEL"

  for profile in "$HOME/.profile" "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -e "$profile" ] || continue
    if ! grep -Fq "$ENV_FILE" "$profile"; then
      printf '\n# ZAI Proxy\n[ -f "$HOME/.config/zai-proxy/env" ] && . "$HOME/.config/zai-proxy/env"\n' >> "$profile"
      info "Shell env hook: $profile"
    fi
  done

  if has_cmd npm; then
    [ -d node_modules ] || run_with_progress "npm install" npm install
    run_with_progress "npm run build" npm run build
  else
    warn "npm nao encontrado; dependencias/build ignorados."
  fi
}

configure_zed() {
  local path="$HOME/.config/zed/settings.json"
  mkdir -p "$(dirname "$path")"
  backup_file "$path"
  python3 - "$path" "$BASE_URL" "$MODEL" "$APP_NAME" <<'PY'
import json, os, re, sys
path, base_url, model, app_name = sys.argv[1:5]
def strip_jsonc(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(^|[^:])//.*", r"\1", text)
    return text.strip() or "{}"
data = {}
if os.path.exists(path) and os.path.getsize(path):
    try:
        data = json.loads(strip_jsonc(open(path, encoding="utf-8").read()))
    except Exception:
        data = {}
provider = {
    "api_url": base_url,
    "available_models": [{
        "name": model,
        "display_name": app_name,
        "max_tokens": 200000,
        "max_output_tokens": 32000,
        "max_completion_tokens": 32000,
        "capabilities": {
            "tools": True,
            "images": False,
            "parallel_tool_calls": True,
            "prompt_cache_key": True,
            "chat_completions": True,
            "interleaved_reasoning": False
        }
    }]
}
data.setdefault("language_models", {}).setdefault("openai_compatible", {})["ZAI Proxy"] = provider
data.setdefault("agent", {}).setdefault("default_model", {"provider": "openai_compatible", "model": model})
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  ok "Zed configurado."
}

configure_codex() {
  local path="$HOME/.codex/config.toml"
  mkdir -p "$(dirname "$path")"
  touch "$path"
  backup_file "$path"
python3 - "$path" "$BASE_URL" "$MODEL" "$APP_NAME" <<'PY'
import re, sys
path, base_url, model, app_name = sys.argv[1:5]
text = open(path, encoding="utf-8").read()
block = f'''# BEGIN ZAI Proxy
[model_providers.zai-proxy]
name = "{app_name}"
base_url = "{base_url}"
env_key = ""
wire_api = "responses"
query_params = {{}}
request_max_retries = 2
stream_max_retries = 1
stream_idle_timeout_ms = 300000
# END ZAI Proxy
'''
text = re.sub(r"# BEGIN [^\n]*Z\.ai Proxy.*?# END [^\n]*Z\.ai Proxy\n?", "", text, flags=re.S)
if "# BEGIN ZAI Proxy" in text:
    text = re.sub(r"# BEGIN ZAI Proxy.*?# END ZAI Proxy\n?", block, text, flags=re.S)
else:
    if not re.search(r"(?m)^model_provider\s*=", text):
        text = f'model = "{model}"\nmodel_provider = "zai-proxy"\n' + text
    text = text.rstrip() + "\n\n" + block
open(path, "w", encoding="utf-8").write(text)
PY
  ok "Codex provider zai-proxy configurado."
}

configure_opencode() {
  local path="$HOME/.config/opencode/opencode.jsonc"
  mkdir -p "$(dirname "$path")"
  backup_file "$path"
  python3 - "$path" "$BASE_URL" "$MODEL" "$SMALL_MODEL" "$APP_NAME" <<'PY'
import json, os, re, sys
path, base_url, model, small_model, app_name = sys.argv[1:6]
def strip_jsonc(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(^|[^:])//.*", r"\1", text)
    return text.strip() or "{}"
data = {}
if os.path.exists(path) and os.path.getsize(path):
    try:
        data = json.loads(strip_jsonc(open(path, encoding="utf-8").read()))
    except Exception:
        data = {}
data.setdefault("$schema", "https://opencode.ai/config.json")
data.setdefault("model", f"z.ai/{model}")
data.setdefault("small_model", f"z.ai/{small_model}")
data.setdefault("provider", {})["z.ai"] = {
    "npm": "@ai-sdk/openai-compatible",
    "name": app_name,
    "options": {"baseURL": base_url},
    "models": {
        model: {"name": model, "limit": {"context": 200000, "output": 32000}},
        small_model: {"name": small_model, "limit": {"context": 200000, "output": 32000}}
    }
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  ok "OpenCode configurado."
}

configure_aider() {
  append_env_if_missing "$ENV_FILE" "OPENAI_API_BASE" "$BASE_URL"
  ok "Aider/OpenAI base URL configurado em $ENV_FILE."
}

configure_claude() {
  warn "Claude Code detectado, mas nao alterado: ele nao consome provider OpenAI-compatible de forma segura."
}

install_client() {
  case "$1" in
    zed) configure_zed ;;
    codex) configure_codex ;;
    opencode) configure_opencode ;;
    aider) configure_aider ;;
    claude) configure_claude ;;
  esac
}

menu() {
  project_header
  maybe_update_self
  detect_clients
  box "Target clients"

  if [ "${#CLIENT_IDS[@]}" -eq 0 ]; then
    warn "Nenhum cliente conhecido detectado."
    prepare_proxy
    return
  fi

  say "  0) Todos os detectados"
  for i in "${!CLIENT_IDS[@]}"; do
    printf "  %d) %s\n" "$((i + 1))" "${CLIENT_NAMES[$i]}"
  done
  say ""
  read -r -p "Selecao: " choice

  prepare_proxy
  if [ "$choice" = "0" ]; then
    for id in "${CLIENT_IDS[@]}"; do install_client "$id"; done
  elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#CLIENT_IDS[@]}" ]; then
    install_client "${CLIENT_IDS[$((choice - 1))]}"
  else
    fail "Opcao invalida."
    exit 1
  fi

  box "Done"
  ok "$APP_NAME configurado."
  say "  Env:    $ENV_FILE"
  say "  Server: npm start"
  say "  Reload: . \"$ENV_FILE\""
}

menu "$@"
