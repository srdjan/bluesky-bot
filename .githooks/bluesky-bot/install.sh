#!/usr/bin/env bash

# Bluesky Bot Installer
# Installs the Bluesky commit poster git hook
# Requires Deno to be installed

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
HOOK_NAME="${HOOK_NAME:-pre-push}"
FORCE=false

# Script directory (where this installer lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============== Helper Functions ===============

print_info() {
    echo -e "${BLUE}ℹ ${NC}$1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_help() {
    cat <<EOF
Bluesky Bot Installer

Usage: ./install.sh [options]

Options:
  --hook=<name>       Hook filename to create (default: pre-push)
  --force             Overwrite existing hook
  -h, --help          Show this help message

Environment:
  HOOK_NAME           Hook name (default: pre-push)
  GIT_HOOK_DIR        Override target directory (default: .git/hooks)

Examples:
  ./install.sh                          # Install pre-push hook
  ./install.sh --hook=post-commit       # Install post-commit hook
  ./install.sh --force                  # Overwrite existing hook
  HOOK_NAME=post-push ./install.sh      # Use environment variable
EOF
}

# =============== Parse Arguments ===============

while [[ $# -gt 0 ]]; do
    case $1 in
        --hook=*)
            HOOK_NAME="${1#*=}"
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            print_help
            exit 1
            ;;
    esac
done

# =============== Check Prerequisites ===============

check_git_repo() {
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        print_error "Not in a git repository"
        echo "Please run this script from within a git repository."
        exit 1
    fi
}

check_deno() {
    if ! command -v deno &> /dev/null; then
        print_error "Deno is not installed"
        echo ""
        echo "This bot requires Deno to run. Please install it first:"
        echo ""
        echo "${GREEN}macOS / Linux / WSL:${NC}"
        echo "  curl -fsSL https://deno.land/install.sh | sh"
        echo ""
        echo "${GREEN}macOS (via Homebrew):${NC}"
        echo "  brew install deno"
        echo ""
        echo "${GREEN}Windows (PowerShell):${NC}"
        echo "  irm https://deno.land/install.ps1 | iex"
        echo ""
        echo "For more: ${BLUE}https://deno.land/manual/getting_started/installation${NC}"
        echo ""
        exit 1
    fi

    local DENO_VERSION
    DENO_VERSION=$(deno --version | head -n1 | awk '{print $2}')
    print_success "Deno is installed (version $DENO_VERSION)"
}

get_repo_root() {
    git rev-parse --show-toplevel
}

# =============== Hook Installation ===============

resolve_hook_dir() {
    local repo_root="$1"

    # Check environment override
    if [[ -n "${GIT_HOOK_DIR:-}" ]]; then
        echo "$GIT_HOOK_DIR"
        return
    fi

    # Check git config
    local hooks_path
    hooks_path=$(git config --get core.hooksPath 2>/dev/null || echo "")

    if [[ -n "$hooks_path" ]]; then
        # Resolve relative paths
        if [[ "$hooks_path" = /* ]]; then
            echo "$hooks_path"
        else
            echo "$repo_root/$hooks_path"
        fi
        return
    fi

    # Default
    echo "$repo_root/.git/hooks"
}

install_hook() {
    local repo_root="$1"
    local hook_dir
    hook_dir=$(resolve_hook_dir "$repo_root")
    local hook_path="$hook_dir/$HOOK_NAME"

    # Create hook directory if it doesn't exist
    mkdir -p "$hook_dir"

    # Check if hook already exists
    if [[ -f "$hook_path" ]] && [[ "$FORCE" != true ]]; then
        print_error "Hook already exists: $hook_path"
        echo "Use --force to overwrite"
        exit 1
    fi

    # Create the hook script
    cat > "$hook_path" <<'HOOK_EOF'
#!/usr/bin/env bash
set -euo pipefail

# Navigate to repository root
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Check if deno is available
if ! command -v deno >/dev/null 2>&1; then
  echo "⚠ deno not found; skipping Bluesky post" >&2
  echo "Install deno: https://deno.land/manual/getting_started/installation" >&2
  exit 0
fi

# Run the bot from its location
exec deno run \
  --allow-env \
  --allow-net \
  --allow-run \
  --allow-read \
  --allow-write \
  .githooks/bluesky-bot/mod.ts
HOOK_EOF

    # Make hook executable
    chmod +x "$hook_path"

    print_success "Installed $HOOK_NAME hook: $hook_path"
}

# =============== Environment Setup ===============

setup_env() {
    local repo_root="$1"
    local env_path="$repo_root/.env"
    local env_example="$SCRIPT_DIR/.env.example"

    if [[ -f "$env_path" ]]; then
        print_success ".env already exists at repository root"
        return
    fi

    if [[ ! -f "$env_example" ]]; then
        print_warning ".env.example not found, skipping environment setup"
        return
    fi

    # Copy .env.example to .env
    cp "$env_example" "$env_path"
    print_success "Created .env from .env.example"
    print_info "Please edit $env_path and add your Bluesky credentials"
}

# =============== Validation ===============

validate_installation() {
    local repo_root="$1"
    local env_path="$repo_root/.env"
    local bot_path="$repo_root/.githooks/bluesky-bot/mod.ts"
    local hook_dir
    hook_dir=$(resolve_hook_dir "$repo_root")
    local hook_path="$hook_dir/$HOOK_NAME"

    echo ""
    echo "=== Installation Summary ==="

    # Check bot script
    if [[ -f "$bot_path" ]]; then
        print_success "Bot script: $bot_path"
    else
        print_error "Bot script not found: $bot_path"
    fi

    # Check hook
    if [[ -f "$hook_path" ]] && [[ -x "$hook_path" ]]; then
        print_success "Git hook: $hook_path"
    else
        print_error "Git hook not found or not executable: $hook_path"
    fi

    # Check .env
    if [[ -f "$env_path" ]]; then
        print_success "Environment: $env_path"

        # Check if credentials are configured
        if grep -q "^BSKY_HANDLE=$" "$env_path" 2>/dev/null; then
            print_warning ".env exists but BSKY_HANDLE is not configured"
        fi
    else
        print_warning "Environment file not found: $env_path"
    fi
}

print_next_steps() {
    local repo_root="$1"
    local env_path="$repo_root/.env"

    echo ""
    echo "=== Next Steps ==="
    echo ""

    # Check if .env needs configuration
    if [[ -f "$env_path" ]] && grep -q "^BSKY_HANDLE=$" "$env_path" 2>/dev/null; then
        echo "${YELLOW}1. Configure your Bluesky credentials:${NC}"
        echo "   Edit: $env_path"
        echo ""
        echo "   Required variables:"
        echo "   - BSKY_HANDLE=yourname.bsky.social"
        echo "   - BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx"
        echo ""
        echo "   Get app password: ${BLUE}https://bsky.app/settings/app-passwords${NC}"
        echo ""
    fi

    echo "${GREEN}2. Test the installation (dry run):${NC}"
    echo "   BLUESKY_DRYRUN=on deno run -A .githooks/bluesky-bot/mod.ts"
    echo ""
    echo "${GREEN}3. Make a test commit:${NC}"
    echo '   git commit --allow-empty -m "Test release v1.0.0"'
    echo "   git push"
    echo ""

    echo "The hook will trigger on git push when your commit message contains:"
    echo "  • A semantic version (v1.2.3, 2.0.0, etc.)"
    echo "  • The @publish keyword"
    echo ""
}

# =============== Main Installation Flow ===============

main() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Bluesky Bot Installer"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Check prerequisites
    check_git_repo
    check_deno

    local repo_root
    repo_root=$(get_repo_root)
    print_info "Repository: $repo_root"
    print_info "Hook name: $HOOK_NAME"
    echo ""

    # Install the git hook
    print_info "Installing git hook..."
    install_hook "$repo_root"
    echo ""

    # Setup environment file
    print_info "Setting up environment..."
    setup_env "$repo_root"
    echo ""

    # Validate installation
    validate_installation "$repo_root"

    # Show next steps
    print_next_steps "$repo_root"

    print_success "Installation complete! 🎉"
    echo ""
}

# Run main installation
main "$@"
