# Document MCP Server

A Node.js [Model Context Protocol](https://modelcontextprotocol.io) server that
runs in Docker and exposes your Unraid SMB share to any MCP-capable LLM client.
It can read PDFs and spreadsheets (Excel/CSV) and lets you run SQL queries
against tabular data via DuckDB.

## Tools

| Tool | Description |
|------|-------------|
| `list_files` | Browse the mounted share; filter by extension, recurse into sub-dirs |
| `read_pdf` | Extract text from a PDF, optionally by page range |
| `read_spreadsheet` | Parse Excel/CSV into structured JSON (all sheets or a named one) |
| `query_spreadsheet` | Run a SQL `SELECT` against a CSV or Excel file using DuckDB |

## Quick start

```bash
# 1. Clone / copy this project onto your Unraid server (or build machine)
git clone <repo-url> document-mcp && cd document-mcp

# 2. Create your .env
cp .env.example .env
# Edit .env — set SHARE_PATH to wherever your SMB share is mounted on the host
nano .env

# 3. Build and start
docker compose up -d --build

# 4. Verify
curl http://localhost:3000/health
```

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SHARE_PATH` | `/mnt/user/Documents` | Host path bind-mounted as `/data` inside the container |
| `TRANSPORT` | `sse` | `stdio` for Claude Desktop, `sse` for HTTP/SSE clients |
| `PORT` | `3000` | Port exposed when `TRANSPORT=sse` |
| `MAX_FILE_SIZE_MB` | `100` | Files larger than this are rejected |
| `MEMORY_LIMIT` | `512m` | Docker memory limit for the container |

## Unraid deploy steps

### 1. Mount your SMB share on the Unraid host

Unraid exposes user shares at `/mnt/user/<sharename>` by default.  If your
share is named `Documents` it is already available at `/mnt/user/Documents`
without any extra configuration.

For a **remote** SMB share (NAS on your LAN), create a persistent mount in
Unraid's **Settings → SMB** or add an entry to `/etc/fstab`:

```
//192.168.1.50/MyShare  /mnt/remotes/MyShare  cifs  credentials=/root/.smb,uid=99,gid=100,iocharset=utf8  0 0
```

Then set `SHARE_PATH=/mnt/remotes/MyShare` in `.env`.

### 2. Place project files on Unraid

Copy the project folder to a persistent location (e.g. an appdata share):

```bash
cp -r document-mcp /mnt/user/appdata/document-mcp
```

### 3. Start with Docker Compose

```bash
cd /mnt/user/appdata/document-mcp
docker compose up -d --build
```

To update later:

```bash
docker compose pull   # if using a pre-built image
docker compose up -d --build --remove-orphans
```

### 4. Auto-start on Unraid boot

In Unraid 6.12+ you can enable **Docker Compose Manager** from Community
Applications and point it at your `docker-compose.yml`.  Alternatively, add a
`User Script` (via the **User Scripts** plugin) that runs at array start:

```bash
#!/bin/bash
cd /mnt/user/appdata/document-mcp && docker compose up -d
```

## Claude Desktop configuration

Use `stdio` transport so Claude Desktop spawns the container and pipes
stdin/stdout through Docker:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json  (macOS)
// %APPDATA%\Claude\claude_desktop_config.json                       (Windows)
{
  "mcpServers": {
    "documents": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "TRANSPORT=stdio",
        "-v", "/mnt/user/Documents:/data:ro",
        "document-mcp-server"
      ]
    }
  }
}
```

> Replace `/mnt/user/Documents` with the actual path on the machine running
> Claude Desktop (this can differ from the Unraid host path if you map the
> share via the host OS).

If the container is already running on Unraid and you prefer to connect over
the network, switch to SSE transport in `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "documents": {
      "command": "npx",
      "args": [
        "-y", "@modelcontextprotocol/inspector",
        "--url", "http://<unraid-ip>:3000/sse"
      ]
    }
  }
}
```

## Local LLM configuration (Ollama / Open WebUI)

With `TRANSPORT=sse`, the server exposes an SSE endpoint.  In Open WebUI go to
**Settings → Tools → Add Tool Server** and enter:

```
http://<unraid-ip>:3000/sse
```

For direct API access (e.g. a custom LangChain agent):

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "documents": {
        "url": "http://<unraid-ip>:3000/sse",
        "transport": "sse",
    }
})
```

## Example queries

```
# List all PDFs in the share
list_files(extensions=[".pdf"], recursive=true)

# Extract pages 1-3 from a report
read_pdf(file_path="Reports/Q1-2024.pdf", page_start=1, page_end=3)

# Read the first 500 rows of an Excel sheet
read_spreadsheet(file_path="Data/Sales.xlsx", sheet_name="January", max_rows=500)

# SQL query against a CSV
query_spreadsheet(
  file_path="Data/transactions.csv",
  sql="SELECT category, SUM(amount) AS total FROM data GROUP BY category ORDER BY total DESC"
)
```

## Security notes

- The container runs as a non-root user (`mcp`).
- The share volume is mounted **read-only** (`:ro`) — the server cannot write
  to your files.
- `query_spreadsheet` only allows `SELECT` statements; DDL and DML are blocked.
- Path traversal outside `SHARE_ROOT` is rejected server-side.
- If you expose port 3000 beyond your LAN, put it behind a reverse proxy with
  authentication (e.g. Nginx Proxy Manager on Unraid).
