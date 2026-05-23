import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { DuckDBInstance } from "@duckdb/node-api";

const SHARE_ROOT = process.env.SHARE_ROOT || "/data";
const PORT = parseInt(process.env.PORT || "3000", 10);
const TRANSPORT = process.env.TRANSPORT || "stdio";
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB || "100", 10) * 1024 * 1024;

// Resolve and validate that a path stays within SHARE_ROOT
function safePath(userPath) {
  const normalized = path.normalize(userPath.startsWith("/") ? userPath : path.join(SHARE_ROOT, userPath));
  const resolved = path.resolve(normalized);
  const root = path.resolve(SHARE_ROOT);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${userPath}" is outside the allowed share directory.`);
  }
  return resolved;
}

async function assertReadable(filePath) {
  try {
    await fs.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${filePath}`);
  }
}

async function assertSizeLimit(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`File exceeds the ${process.env.MAX_FILE_SIZE_MB || 100} MB size limit.`);
  }
}

// ── DuckDB helper ─────────────────────────────────────────────────────────────

async function runDuckDB(sql) {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const result = await conn.runAndReadAll(sql);
    const raw = result.getRowObjectsJS();
    // BigInt values (e.g. INTEGER columns) must be converted for JSON serialization
    return JSON.parse(JSON.stringify(raw, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
  } finally {
    conn.disconnectSync();
    instance.closeSync();
  }
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "document-server",
  version: "1.0.0",
});

// ── Tool: list_files ──────────────────────────────────────────────────────────

server.tool(
  "list_files",
  "List files and directories inside the mounted share. Omit 'dir_path' to list the root.",
  {
    dir_path: z.string().optional().describe("Relative or absolute path within the share to list. Defaults to the share root."),
    recursive: z.boolean().optional().describe("Recurse into sub-directories (default false)."),
    extensions: z.array(z.string()).optional().describe("Filter by file extensions, e.g. [\".pdf\", \".xlsx\"]. Case-insensitive."),
  },
  async ({ dir_path, recursive = false, extensions }) => {
    const target = safePath(dir_path || SHARE_ROOT);
    await assertReadable(target);

    const exts = extensions ? extensions.map((e) => e.toLowerCase().replace(/^(?!\.)/, ".")) : null;

    async function walk(dir, depth = 0) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(SHARE_ROOT, fullPath);
        if (entry.isDirectory()) {
          results.push({ type: "directory", path: rel, name: entry.name });
          if (recursive) {
            results.push(...(await walk(fullPath, depth + 1)));
          }
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (!exts || exts.includes(ext)) {
            const stat = await fs.stat(fullPath);
            results.push({
              type: "file",
              path: rel,
              name: entry.name,
              extension: ext,
              size_bytes: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        }
      }
      return results;
    }

    const items = await walk(target);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ root: path.relative(SHARE_ROOT, target) || ".", items }, null, 2),
        },
      ],
    };
  }
);

// ── Tool: read_pdf ────────────────────────────────────────────────────────────

server.tool(
  "read_pdf",
  "Extract text content from a PDF file. Returns page-by-page text.",
  {
    file_path: z.string().describe("Path to the PDF file (relative to share root, or absolute)."),
    page_start: z.number().int().min(1).optional().describe("First page to extract (1-indexed). Default: 1."),
    page_end: z.number().int().min(1).optional().describe("Last page to extract (inclusive). Default: all pages."),
  },
  async ({ file_path, page_start, page_end }) => {
    const abs = safePath(file_path);
    await assertReadable(abs);
    await assertSizeLimit(abs);

    const buffer = await fs.readFile(abs);
    const data = await pdfParse(buffer);

    const totalPages = data.numpages;
    const start = Math.max(1, page_start || 1);
    const end = Math.min(totalPages, page_end || totalPages);

    // pdf-parse gives us all text; split roughly by form-feed if present
    const rawPages = data.text.split(/\f/);
    const pages = rawPages.length > 1 ? rawPages : [data.text];

    const selectedPages = pages.slice(start - 1, end).map((text, i) => ({
      page: start + i,
      text: text.trim(),
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: path.relative(SHARE_ROOT, abs),
              total_pages: totalPages,
              extracted_pages: `${start}-${end}`,
              info: data.info,
              pages: selectedPages,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: read_spreadsheet ────────────────────────────────────────────────────

server.tool(
  "read_spreadsheet",
  "Parse an Excel (.xlsx, .xls) or CSV file and return structured JSON. Each sheet becomes an array of row objects.",
  {
    file_path: z.string().describe("Path to the spreadsheet file (relative to share root, or absolute)."),
    sheet_name: z.string().optional().describe("Name of a specific sheet to read. Omit to read all sheets."),
    max_rows: z.number().int().min(1).optional().describe("Maximum number of rows to return per sheet (default 1000)."),
    header_row: z.number().int().min(1).optional().describe("Row number that contains headers (1-indexed, default 1)."),
  },
  async ({ file_path, sheet_name, max_rows = 1000, header_row = 1 }) => {
    const abs = safePath(file_path);
    await assertReadable(abs);
    await assertSizeLimit(abs);

    const buffer = await fs.readFile(abs);
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

    const sheetNames = sheet_name ? [sheet_name] : workbook.SheetNames;
    const result = {};

    for (const name of sheetNames) {
      const sheet = workbook.Sheets[name];
      if (!sheet) throw new Error(`Sheet "${name}" not found. Available: ${workbook.SheetNames.join(", ")}`);

      const rows = XLSX.utils.sheet_to_json(sheet, {
        defval: null,
        dateNF: "yyyy-mm-dd",
        range: header_row - 1,
      });

      result[name] = {
        total_rows: rows.length,
        returned_rows: Math.min(rows.length, max_rows),
        data: rows.slice(0, max_rows),
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: path.relative(SHARE_ROOT, abs),
              sheets: sheetNames,
              data: result,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Tool: query_spreadsheet ───────────────────────────────────────────────────

server.tool(
  "query_spreadsheet",
  "Run a SQL query against a CSV or Excel file using DuckDB. For Excel files the data is first exported to a temp CSV. Use the table name 'data' in your SQL.",
  {
    file_path: z.string().describe("Path to the CSV or Excel file (relative to share root, or absolute)."),
    sql: z.string().describe("SQL SELECT statement. Reference the file as the table named 'data'. Example: SELECT * FROM data WHERE amount > 1000 LIMIT 50"),
    sheet_name: z.string().optional().describe("Sheet name to query (Excel only, default: first sheet)."),
  },
  async ({ file_path, sql, sheet_name }) => {
    const abs = safePath(file_path);
    await assertReadable(abs);
    await assertSizeLimit(abs);

    // Reject obviously dangerous SQL
    const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|COPY|EXPORT|IMPORT|CALL|PRAGMA)\b/i;
    if (forbidden.test(sql)) {
      throw new Error("Only SELECT statements are allowed.");
    }

    const ext = path.extname(abs).toLowerCase();
    let csvPath = abs;
    let tempFile = null;

    // For Excel files, convert the target sheet to a temp CSV first
    if (ext === ".xlsx" || ext === ".xls" || ext === ".ods") {
      const { mkdtemp, writeFile } = await import("fs/promises");
      const { tmpdir } = await import("os");
      const tmpDir = await mkdtemp(path.join(tmpdir(), "mcp-"));
      tempFile = path.join(tmpDir, "data.csv");

      const buffer = await fs.readFile(abs);
      const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
      const targetSheet = sheet_name || workbook.SheetNames[0];
      if (!workbook.Sheets[targetSheet]) {
        throw new Error(`Sheet "${targetSheet}" not found. Available: ${workbook.SheetNames.join(", ")}`);
      }
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[targetSheet]);
      await writeFile(tempFile, csv);
      csvPath = tempFile;
    }

    // Rewrite 'data' table references to the actual CSV path
    const escapedPath = csvPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const rewrittenSql = sql.replace(/\bdata\b/gi, `read_csv_auto('${escapedPath}')`);

    let rows;
    try {
      rows = await runDuckDB(rewrittenSql);
    } finally {
      if (tempFile) {
        const { rm } = await import("fs/promises");
        await rm(path.dirname(tempFile), { recursive: true, force: true });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: path.relative(SHARE_ROOT, abs),
              sql,
              row_count: rows.length,
              rows,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Transport ─────────────────────────────────────────────────────────────────

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startSSE() {
  const app = express();
  const transports = new Map();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post("/messages", express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => res.json({ status: "ok", transport: "sse" }));

  app.listen(PORT, () => {
    process.stderr.write(`Document MCP server listening on port ${PORT} (SSE)\n`);
    process.stderr.write(`SSE endpoint: http://localhost:${PORT}/sse\n`);
  });
}

if (TRANSPORT === "sse") {
  await startSSE();
} else {
  await startStdio();
}
