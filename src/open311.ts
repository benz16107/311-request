/**
 * Toronto Open311 (GeoReport v2) client — transport-agnostic.
 *
 * No MCP, no HTTP server here: just config, the raw Open311 calls, and typed
 * operations. The same logic can be imported directly by a backend service
 * (e.g. a pothole-detection pipeline), wrapped in an HTTP endpoint, or exposed
 * over MCP. mcp.ts is one such thin adapter; src/complaints.ts is the
 * higher-level orchestration most application code should import.
 *
 * Config via env (defaults point at the public TEST sandbox — no real requests):
 *   TORONTO_311_BASE_URL         default https://secure.toronto.ca/open311test/ws
 *   TORONTO_311_JURISDICTION_ID  default toronto.ca
 *   TORONTO_311_API_KEY          required only to POST (file a request)
 */

export const BASE_URL = (process.env.TORONTO_311_BASE_URL ?? "https://secure.toronto.ca/open311test/ws").replace(/\/+$/, "");
export const JURISDICTION_ID = process.env.TORONTO_311_JURISDICTION_ID ?? "toronto.ca";
export const API_KEY = process.env.TORONTO_311_API_KEY ?? "";

// The old self-serve form (webwizard/start.jsp) is retired; keys are now issued
// manually. See README for the current request process.
export const API_KEY_REQUEST_CONTACT = "the City of Toronto Open Data team <opendata@toronto.ca>";

// ---------------------------------------------------------------------------
// Low-level client
// ---------------------------------------------------------------------------

export type Json = any;

export class Open311Error extends Error {
  constructor(message: string, readonly status?: number, readonly snippet?: string) {
    super(message);
    this.name = "Open311Error";
  }
}

type CallOpts = {
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  form?: Record<string, string | undefined>;
};

export async function call(path: string, opts: CallOpts = {}): Promise<Json> {
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
// Typed operations (one per GeoReport v2 endpoint)
// ---------------------------------------------------------------------------

/** GET services.json — which service request types can be filed. */
export function listServiceTypes(): Promise<Json> {
  return call("services.json");
}

/** GET services/{code}.json — required/optional attribute fields for a type. */
export function getServiceDefinition(serviceCode: string): Promise<Json> {
  return call(`services/${encodeURIComponent(serviceCode)}.json`);
}

/** Flat shape mirroring the Open311 POST fields. */
export interface FileRequestInput {
  service_code: string;
  description: string;
  lat?: number;
  long?: number;
  address_string?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  media_url?: string;
  attributes?: Record<string, string>;
}

/** True if the request carries a usable location (coords or an address). */
export function hasLocation(input: FileRequestInput): boolean {
  return (input.lat !== undefined && input.long !== undefined) || !!input.address_string;
}

/** Build the x-www-form-urlencoded field map for a POST requests.json. */
export function buildRequestForm(input: FileRequestInput): Record<string, string | undefined> {
  const form: Record<string, string | undefined> = {
    api_key: API_KEY,
    service_code: input.service_code,
    description: input.description,
    lat: input.lat?.toString(),
    long: input.long?.toString(),
    address_string: input.address_string,
    first_name: input.first_name,
    last_name: input.last_name,
    email: input.email,
    phone: input.phone,
    media_url: input.media_url,
  };
  for (const [k, v] of Object.entries(input.attributes ?? {})) {
    form[`attribute[${k}]`] = v;
  }
  return form;
}

/** POST requests.json — file a request. Throws Open311Error without a key/location. */
export function fileServiceRequest(input: FileRequestInput): Promise<Json> {
  if (!API_KEY) {
    throw new Open311Error(
      `TORONTO_311_API_KEY is not set. Toronto requires a registered API key to file a request — ` +
        `request one from ${API_KEY_REQUEST_CONTACT}.`,
    );
  }
  if (!hasLocation(input)) {
    throw new Open311Error("A location is required: provide lat AND long, or address_string.");
  }
  return call("requests.json", { method: "POST", form: buildRequestForm(input) });
}

/** GET requests/{id}.json or tokens/{token}.json — track a filed request. */
export function checkRequestStatus(args: { service_request_id?: string; token?: string }): Promise<Json> {
  const { service_request_id, token } = args;
  if (!service_request_id && !token) {
    throw new Open311Error("Provide a service_request_id or a token.");
  }
  const query = { api_key: API_KEY || undefined };
  if (token && !service_request_id) {
    return call(`tokens/${encodeURIComponent(token)}.json`, { query });
  }
  return call(`requests/${encodeURIComponent(service_request_id!)}.json`, { query });
}
