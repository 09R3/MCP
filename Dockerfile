FROM node:20-slim AS base

# @duckdb/node-api ships pre-built binaries; no native compilation needed.
# canvas (optional dep of pdf-parse) may need libcairo — skip it as we don't use canvas.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY index.js ./

# Non-root user for least privilege
RUN groupadd -r mcp && useradd -r -g mcp mcp
USER mcp

# Default share mount point
VOLUME ["/data"]

ENV NODE_ENV=production \
    SHARE_ROOT=/data \
    TRANSPORT=stdio \
    PORT=3000 \
    MAX_FILE_SIZE_MB=100

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" || exit 1

ENTRYPOINT ["node", "index.js"]
