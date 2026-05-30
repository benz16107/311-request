#!/usr/bin/env node
/**
 * Toronto 311 (Open311 GeoReport v2) MCP server — everything in one file.
 *
 * Wraps the City of Toronto's Open311 API as four MCP tools:
 *   - list_service_types      → GET  services.json          (what can I file?)
 *   - get_service_definition  → GET  services/{code}.json   (required fields)
 *   - file_service_request    → POST requests.json          (file it — needs api_key)
 *   - check_request_status    → GET  requests/{id}.json     (track it)
 *
 * Config via env (defaults point at the public TEST sandbox — no real requests filed):
 *   TORONTO_311_BASE_URL         default https://secure.toronto.ca/open311test/ws
 *   TORONTO_311_JURISDICTION_ID  default toronto.ca
 *   TORONTO_311_API_KEY          required only to POST (file_service_request)
 *
 * Run:  npx tsx mcp.ts        (speaks MCP over stdio)
 *
 * The Open311Client below is deliberately decoupled from the MCP wiring, so the
 * same logic drops into an HTTP MCP server or a queue worker unchanged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.TORONTO_311_BASE_URL ?? "https://secure.toronto.ca/open311test/ws").replace(/\/+$/, "");
const JURISDICTION_ID = process.env.TORONTO_311_JURISDICTION_ID ?? "toronto.ca";
const API_KEY = process.env.TORONTO_311_API_KEY ?? "";

const API_KEY_REQUEST_URL = "https://secure.toronto.ca/webwizard/start.jsp?_wiz_id=API_key_request";

// ---------------------------------------------------------------------------
// Open311 client
// ---------------------------------------------------------------------------

type Json = any;

class Open311Error extends Error {
  constructor(message: string, readonly status?: number, readonly snippet?: string) {
    super(message);
  }
}

type CallOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  form?: Record<string, string | undefined>;
};

async function call(path: string, opts: CallOpts = {}): Promise<Json> {
  const method = opts.method ?? "GET";
  const url = new URL(`${BASE_URL}/${path}`);
  url.searchParams.set("jurisdiction_id", JURISDICTION_ID);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    "User-Agent": "toronto-311-mcp/0.1 (+https://modelcontextprotocol.io)",
    Accept: "application/json",
  };

  let body: string | undefined;
  if (method === "POST") {
    const params = new URLSearchParams();
    params.set("jurisdiction_id", JURISDICTION_ID);
    for (const [k, v] of Object.entries(opts.form ?? {})) {
      if (v !== undefined && v !== "") params.set(k, v);
    }
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    throw new Open311Error(`Network error calling ${url.pathname}: ${(e as Error).message}`);
  }

  const text = await res.text();
  const looksHtml = /^\s*</.test(text);

  if (!res.ok) {
    if (res.status === 403 && /access denied|edgesuite|akamai/i.test(text)) {
      throw new Open311Error(
        "Blocked by Toronto's edge/WAF (HTTP 403 Access Denied). This usually means the call needs a " +
          "registered API key and/or must originate from an allow-listed network — not that the endpoint is down.",
        res.status,
        text.slice(0, 400),
      );
    }
    throw new Open311Error(`Toronto 311 returned HTTP ${res.status}.`, res.status, text.slice(0, 800));
  }

  if (looksHtml) {
    throw new Open311Error("Expected JSON but got an HTML page (likely an error/login page).", res.status, text.slice(0, 400));
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Open311Error("Response was not valid JSON.", res.status, text.slice(0, 400));
  }
}

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

function ok(data: Json) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const err = e instanceof Open311Error ? e : new Open311Error((e as Error).message ?? String(e));
  const text = err.snippet ? `${err.message}\n\n--- response snippet ---\n${err.snippet}` : err.message;
  return { isError: true, content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "toronto-311", version: "0.1.0" });

server.registerTool(
  "list_service_types",
  {
    title: "List Toronto 311 service types",
    description:
      "Discover which 311 service request types can be filed (e.g. graffiti, pothole). Returns each service_code, " +
      "service_name, description, group, and whether it needs extra 'metadata' fields. Call this FIRST — only the " +
      "service_codes it returns are valid inputs to file_service_request.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await call("services.json"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_service_definition",
  {
    title: "Get required fields for a 311 service type",
    description:
      "For a service_code whose 'metadata' flag is true, returns the attribute definitions (required/optional custom " +
      "fields and their allowed values) you must supply when filing. You can skip this for services with metadata=false.",
    inputSchema: {
      service_code: z.string().describe("A service_code from list_service_types, e.g. 'CSROSC-14'."),
    },
  },
  async ({ service_code }) => {
    try {
      return ok(await call(`services/${encodeURIComponent(service_code)}.json`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "file_service_request",
  {
    title: "File a Toronto 311 service request / complaint",
    description:
      "Submit a new 311 service request. Requires TORONTO_311_API_KEY to be set. You MUST provide a service_code and a " +
      "location: either lat AND long, or address_string. Returns a service_request_id (or a token to resolve later via " +
      "check_request_status). When the service type has metadata=true, pass its required fields in `attributes`.",
    inputSchema: {
      service_code: z.string().describe("Service type from list_service_types."),
      description: z.string().describe("Free-text description of the issue being reported."),
      lat: z.number().optional().describe("Latitude (WGS84). Provide lat+long OR address_string."),
      long: z.number().optional().describe("Longitude (WGS84)."),
      address_string: z.string().optional().describe("Human-readable address, used if you don't have coordinates."),
      first_name: z.string().optional().describe("Reporter first name (optional)."),
      last_name: z.string().optional().describe("Reporter last name (optional)."),
      email: z.string().optional().describe("Reporter email for status updates (optional)."),
      phone: z.string().optional().describe("Reporter phone (optional)."),
      media_url: z.string().optional().describe("URL of a photo of the issue (optional)."),
      attributes: z
        .record(z.string())
        .optional()
        .describe("Custom metadata fields from get_service_definition as { CODE: value }; sent as attribute[CODE]=value."),
    },
  },
  async (args) => {
    try {
      if (!API_KEY) {
        return fail(
          new Open311Error(
            "TORONTO_311_API_KEY is not set. Toronto requires a registered API key to file a request. " +
              `Request one at ${API_KEY_REQUEST_URL}`,
          ),
        );
      }
      const hasCoords = args.lat !== undefined && args.long !== undefined;
      if (!hasCoords && !args.address_string) {
        return fail(new Open311Error("A location is required: provide lat AND long, or address_string."));
      }

      const form: Record<string, string | undefined> = {
        api_key: API_KEY,
        service_code: args.service_code,
        description: args.description,
        lat: args.lat?.toString(),
        long: args.long?.toString(),
        address_string: args.address_string,
        first_name: args.first_name,
        last_name: args.last_name,
        email: args.email,
        phone: args.phone,
        media_url: args.media_url,
      };
      for (const [k, v] of Object.entries(args.attributes ?? {})) {
        form[`attribute[${k}]`] = v;
      }

      return ok(await call("requests.json", { method: "POST", form }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "check_request_status",
  {
    title: "Check status of a Toronto 311 request",
    description:
      "Look up a previously filed request by its service_request_id (or by the token returned at submission time before " +
      "an id has been assigned).",
    inputSchema: {
      service_request_id: z.string().optional().describe("The id returned by file_service_request."),
      token: z.string().optional().describe("Use if submission returned only a token (id not yet assigned)."),
    },
  },
  async ({ service_request_id, token }) => {
    try {
      if (!service_request_id && !token) {
        return fail(new Open311Error("Provide a service_request_id or a token."));
      }
      const query = { api_key: API_KEY || undefined };
      if (token && !service_request_id) {
        return ok(await call(`tokens/${encodeURIComponent(token)}.json`, { query }));
      }
      return ok(await call(`requests/${encodeURIComponent(service_request_id!)}.json`, { query }));
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Boot (stdio). NOTE: never write to stdout here — it carries the MCP protocol.
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[toronto-311] ready — base=${BASE_URL} jurisdiction=${JURISDICTION_ID} api_key=${API_KEY ? "set" : "MISSING (read-only)"}`,
);
