/**
 * High-level complaint submission — the entry point application code should
 * import (e.g. a pothole-detection service: `import { submitComplaint } from
 * "./src/complaints"`).
 *
 * It normalizes a domain "issue" into an Open311 request and routes it through
 * a pluggable backend, so the caller's code never changes as availability does:
 *
 *   - "api":   real POST to Open311 (needs API key + allow-listed IP)
 *   - "draft": returns a ready-to-submit package + a human-handoff (works today,
 *              no key) — a person submits via the official form or email
 *
 * Default backend = "api" when an API key is configured, otherwise "draft".
 * When the key + IP allow-listing arrive, set TORONTO_311_API_KEY and nothing
 * upstream needs to change.
 */

import {
  API_KEY,
  fileServiceRequest,
  hasLocation,
  Open311Error,
  type FileRequestInput,
  type Json,
} from "./open311";

const OFFICIAL_FORM_URL =
  "https://www.toronto.ca/home/311-toronto-at-your-service/create-a-service-request/service-request/";

// Optional: set if you want drafts to target a specific 311 intake mailbox.
const CONTACT_EMAIL = process.env.TORONTO_311_CONTACT_EMAIL ?? "";

export type LatLong = { lat: number; long: number };
export type Address = { addressString: string };

/** A domain issue to report (what a pothole service would hand off). */
export interface ComplaintInput {
  /** A valid service_code from listServiceTypes(), e.g. the pothole code. */
  serviceCode: string;
  /** Free-text description of the issue. */
  description: string;
  /** Where it is — coordinates preferred, address as a fallback. */
  location: LatLong | Address;
  /** Optional reporter contact for status updates. */
  reporter?: { firstName?: string; lastName?: string; email?: string; phone?: string };
  /** Optional photo URL (e.g. the pothole image your service captured). */
  mediaUrl?: string;
  /** Custom metadata fields from getServiceDefinition(), as { CODE: value }. */
  attributes?: Record<string, string>;
}

export type SubmitMode = "api" | "draft";

export type SubmitResult =
  | { status: "filed"; serviceRequestId?: string; token?: string; raw: Json }
  | {
      status: "draft";
      reason: string;
      request: FileRequestInput;
      handoff: {
        /** Official online form a human can complete. */
        formUrl: string;
        /** Pre-formatted email a human can review and send. */
        email: { to: string; subject: string; body: string };
      };
    };

function isLatLong(loc: LatLong | Address): loc is LatLong {
  return "lat" in loc;
}

function toFileRequestInput(input: ComplaintInput): FileRequestInput {
  const loc = input.location;
  return {
    service_code: input.serviceCode,
    description: input.description,
    lat: isLatLong(loc) ? loc.lat : undefined,
    long: isLatLong(loc) ? loc.long : undefined,
    address_string: isLatLong(loc) ? undefined : loc.addressString,
    first_name: input.reporter?.firstName,
    last_name: input.reporter?.lastName,
    email: input.reporter?.email,
    phone: input.reporter?.phone,
    media_url: input.mediaUrl,
    attributes: input.attributes,
  };
}

function describeLocation(req: FileRequestInput): string {
  if (req.lat !== undefined && req.long !== undefined) return `${req.lat}, ${req.long}`;
  return req.address_string ?? "(no location given)";
}

function buildDraft(req: FileRequestInput, reason: string): SubmitResult {
  const lines = [
    `Service type (service_code): ${req.service_code}`,
    `Location: ${describeLocation(req)}`,
    `Description: ${req.description}`,
  ];
  if (req.media_url) lines.push(`Photo: ${req.media_url}`);
  const who = [req.first_name, req.last_name].filter(Boolean).join(" ");
  if (who) lines.push(`Reported by: ${who}`);
  if (req.email) lines.push(`Contact email: ${req.email}`);
  if (req.phone) lines.push(`Contact phone: ${req.phone}`);
  for (const [k, v] of Object.entries(req.attributes ?? {})) lines.push(`${k}: ${v}`);

  return {
    status: "draft",
    reason,
    request: req,
    handoff: {
      formUrl: OFFICIAL_FORM_URL,
      email: {
        to: CONTACT_EMAIL,
        subject: `311 service request: ${req.service_code} at ${describeLocation(req)}`,
        body: lines.join("\n"),
      },
    },
  };
}

/**
 * Submit (or draft) a complaint. The default backend is chosen from whether an
 * API key is configured; override with `opts.mode` to force one.
 */
export async function submitComplaint(
  input: ComplaintInput,
  opts: { mode?: SubmitMode } = {},
): Promise<SubmitResult> {
  const req = toFileRequestInput(input);
  if (!hasLocation(req)) {
    throw new Open311Error("A location is required: provide { lat, long } or { addressString }.");
  }

  const mode: SubmitMode = opts.mode ?? (API_KEY ? "api" : "draft");

  if (mode === "draft") {
    return buildDraft(
      req,
      API_KEY
        ? "Draft mode requested — not submitted to the API."
        : "No API key configured — returning a draft for a human to submit (form or email).",
    );
  }

  // mode === "api": real submission. Open311 returns an array of result objects.
  const raw = await fileServiceRequest(req);
  const first = Array.isArray(raw) ? raw[0] : raw;
  return {
    status: "filed",
    serviceRequestId: first?.service_request_id != null ? String(first.service_request_id) : undefined,
    token: first?.token != null ? String(first.token) : undefined,
    raw,
  };
}
