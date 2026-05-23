#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Document MCP Server — Unraid Deploy Script  (production)
#  Save this file to: /mnt/user/appdata/document-mcp/deploy.sh
#  Run with:  bash /mnt/user/appdata/document-mcp/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ── Config (edit these if needed) ────────────────────────────────────────────
APPDATA_DIR="/mnt/user/appdata/mcp"
REPO_URL="https://github.com/09r3/mcp"
BRANCH="main"
CONTAINER_NAME="mcp"
IMAGE_NAME="mcp"
HOST_PORT=3167              # port exposed on Unraid (SSE/HTTP endpoint)
CONTAINER_PORT=3000         # port inside the container (matches PORT in .env)
SHARE_PATH="/mnt/user/ai"   # Unraid SMB share mounted read-only as /data
# ─────────────────────────────────────────────────────────────────────────────

pENV_FILE="$APPDATA_DIR/.env"
SOURCE_DIR="$APPDATA_DIR/_source"

echo ""
echo "══════════════════════════════════════════"
echo "  Document MCP Server Deploy"
echo "  Branch : $BRANCH"
echo "  Port   : $HOST_PORT"
echo "  Share  : $SHARE_PATH"
echo "══════════════════════════════════════════"
echo ""

# ── 1. Create appdata dir if needed ──────────────────────────────────────────
mkdir -p "$APPDATA_DIR"
cd "$APPDATA_DIR"

# ── 2. First-run: create .env from template and exit ─────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "[1/5] No .env found — creating from template..."

    curl -fsSL \
        "https://raw.githubusercontent.com/09r3/mcp/$BRANCH/.env.example" \
        -o "$ENV_FILE" 2>/dev/null \
    || {
        # Fallback minimal template if curl fails
        cat > "$ENV_FILE" <<'EOF'
# Path to the SMB share on the Unraid host, mounted read-only as /data inside
# the container.  Change this to match your actual share path.
SHARE_PATH=/mnt/user/Documents

# Transport mode:
#   sse   — HTTP + Server-Sent Events endpoint (for Ollama, Open WebUI, etc.)
#   stdio — stdin/stdout only (for Claude Desktop running docker run -i)
TRANSPORT=sse

# Port the SSE server listens on inside the container.
# The deploy script maps HOST_PORT -> CONTAINER_PORT on the host.
PORT=3000

# Files larger than this (MB) are rejected to prevent OOM inside the container.
MAX_FILE_SIZE_MB=100

# Docker memory limit for the container.
MEMORY_LIMIT=512m
EOF
    }

    echo ""
    echo "  ┌──────────────────────────────────────────────────┐"
    echo "  │  ACTION REQUIRED                                 │"
    echo "  │  Review and edit the settings file:             │"
    echo "  │  $ENV_FILE"
    echo "  │                                                  │"
    echo "  │  Key setting — set SHARE_PATH to the path of    │"
    echo "  │  your SMB share on this Unraid machine, e.g.:   │"
    echo "  │    SHARE_PATH=/mnt/user/Documents               │"
    echo "  │                                                  │"
    echo "  │  Then re-run this script.                        │"
    echo "  └──────────────────────────────────────────────────┘"
    echo ""
    exit 0
fi

# Load SHARE_PATH from .env if overridden there
if grep -q "^SHARE_PATH=" "$ENV_FILE" 2>/dev/null; then
    SHARE_PATH=$(grep "^SHARE_PATH=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

# ── 3. Stop and remove existing container ────────────────────────────────────
echo "[1/5] Stopping old container (if running)..."
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker stop "$CONTAINER_NAME" >/dev/null && docker rm "$CONTAINER_NAME" >/dev/null
    echo "      Stopped and removed."
else
    echo "      No existing container found."
fi

# ── 4. Pull latest source ─────────────────────────────────────────────────────
echo "[2/5] Downloading latest code from GitHub..."
rm -rf "$SOURCE_DIR"

git clone \
    --depth 1 \
    --branch "$BRANCH" \
    --quiet \
    "$REPO_URL" \
    "$SOURCE_DIR"

cd "$APPDATA_DIR"
echo "      Done."

# ── 5. Build Docker image ─────────────────────────────────────────────────────
echo "[3/5] Building Docker image..."
docker build \
    --tag "$IMAGE_NAME" \
    --quiet \
    "$SOURCE_DIR"
echo "      Built."

# ── 6. Clean up source clone ──────────────────────────────────────────────────
echo "[4/5] Cleaning up source files..."
rm -rf "$SOURCE_DIR"
echo "      Done."

# ── 7. Validate share path ────────────────────────────────────────────────────
if [ ! -d "$SHARE_PATH" ]; then
    echo ""
    echo "  ┌──────────────────────────────────────────────────┐"
    echo "  │  WARNING                                         │"
    echo "  │  Share path not found on this host:             │"
    echo "  │  $SHARE_PATH"
    echo "  │                                                  │"
    echo "  │  The container will start but the /data volume  │"
    echo "  │  will be empty until the share is mounted.      │"
    echo "  └──────────────────────────────────────────────────┘"
    echo ""
    mkdir -p "$SHARE_PATH"
fi

# ── 8. Run the container ──────────────────────────────────────────────────────
echo "[5/5] Starting container..."
docker run \
    --detach \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --publish "${HOST_PORT}:${CONTAINER_PORT}" \
    --env-file "$ENV_FILE" \
    --volume "${SHARE_PATH}:/data:ro" \
    --memory "${MEMORY_LIMIT:-512m}" \
    "$IMAGE_NAME" \
    >/dev/null

# ── Done ──────────────────────────────────────────────────────────────────────
HOST_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "  ┌──────────────────────────────────────────────────┐"
echo "  │  ✓  Document MCP Server is running!             │"
echo "  │                                                  │"
echo "  │  SSE endpoint:                                   │"
echo "  │  http://${HOST_IP}:${HOST_PORT}/sse"
echo "  │                                                  │"
echo "  │  Health check:                                   │"
echo "  │  http://${HOST_IP}:${HOST_PORT}/health"
echo "  │                                                  │"
echo "  │  Share mounted from:                             │"
echo "  │  ${SHARE_PATH}"
echo "  │                                                  │"
echo "  │  To view logs:                                   │"
echo "  │  docker logs -f $CONTAINER_NAME                 │"
echo "  └──────────────────────────────────────────────────┘"
echo ""
