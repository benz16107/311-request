#!/usr/bin/env node
/**
 * Toronto 311 (Open311 GeoReport v2) MCP server — a THIN ADAPTER.
 *
 * All Open311 logic lives in src/open311.ts; higher-level complaint
 * orchestration (with a pluggable api/draft backend) lives in src/complaints.ts.
 * Both are MCP-free, so the same code can be imported directly by a backend
 * service or wrapped in HTTP. This file only maps those functions onto MCP tools
 * for agent/LLM callers.
 *
 * Tools:
 *   - list_service_types      → listServiceTypes()      (what can I file?)
 *   - get_service_definition  → getServiceDefinition()  (required fields)
 *   - file_service_request    → fileServiceRequest()    (file it — needs api_key)
 *   - check_request_status    → checkRequestStatus()    (track it)
 *
 * Run:  npx tsx mcp.ts        (speaks MCP over stdio)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  API_KEY,
  BASE_URL,
  JURISDICTION_ID,
  Open311Error,
  checkRequestStatus,
  fileServiceRequest,
  getServiceDefinition,
  listServiceTypes,
  type Json,
} from "./src/open311";

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
      return ok(await listServiceTypes());
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
      return ok(await getServiceDefinition(service_code));
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
      return ok(await fileServiceRequest(args));
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
      return ok(await checkRequestStatus({ service_request_id, token }));
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
