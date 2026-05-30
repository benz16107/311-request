# toronto-311-mcp

A single-file MCP server that wraps the City of Toronto's **Open311 GeoReport v2** API so an
LLM/agent can discover, file, and track 311 service requests (e.g. graffiti, potholes).

The logic is split so the Open311 code is **transport-agnostic**:

- [`src/open311.ts`](src/open311.ts) — the GeoReport v2 client + typed operations (no MCP).
- [`src/complaints.ts`](src/complaints.ts) — `submitComplaint()`, the high-level entry point app code
  imports. Routes through a **pluggable backend**: a real API `POST`, or a `draft` (ready-to-submit
  package + human handoff) when no key is available.
- [`mcp.ts`](mcp.ts) — a thin MCP adapter over the above, for agent/LLM callers.

So a backend service (e.g. a pothole detector) imports `submitComplaint` directly, while an agent
reaches the same logic over MCP — no duplicated logic.

## Tools

| Tool | Open311 call | Purpose |
|---|---|---|
| `list_service_types` | `GET services.json` | What can I file? (valid `service_code`s) |
| `get_service_definition` | `GET services/{code}.json` | Required/optional fields for a type (when `metadata=true`) |
| `file_service_request` | `POST requests.json` | File a request — **needs an API key** |
| `check_request_status` | `GET requests/{id}.json` | Track by `service_request_id` or `token` |

## Run

```bash
npm install
# sandbox by default — safe, no real requests filed:
npm run dev
# or poke at it interactively:
npm run inspect
```

Env vars (see [`.env.example`](.env.example)): `TORONTO_311_BASE_URL`,
`TORONTO_311_JURISDICTION_ID`, `TORONTO_311_API_KEY`.

### Wire into an MCP client (stdio)

```jsonc
{
  "mcpServers": {
    "toronto-311": {
      "command": "npx",
      "args": ["tsx", "/Users/benzhou/toronto-311-mcp/mcp.ts"],
      "env": {
        "TORONTO_311_BASE_URL": "https://secure.toronto.ca/open311test/ws",
        "TORONTO_311_API_KEY": ""
      }
    }
  }
}
```

## Use from your own service (direct import)

A backend service imports the high-level function in-process — no MCP, no HTTP:

```ts
import { submitComplaint } from "./src/complaints";

const result = await submitComplaint({
  serviceCode: "pothole",                 // a code from listServiceTypes()
  description: "Large pothole, curb lane, ~40cm wide.",
  location: { lat: 43.6532, long: -79.3832 }, // or { addressString: "100 Queen St W" }
  mediaUrl: "https://.../pothole.jpg",
  reporter: { firstName: "Ben", email: "you@example.com" },
});

if (result.status === "filed") {
  console.log("service_request_id:", result.serviceRequestId);
} else {
  // No API key yet → a draft to submit by hand (official form or email).
  console.log(result.handoff.formUrl, result.handoff.email);
}
```

The backend is chosen automatically: real `POST` when `TORONTO_311_API_KEY` is set, otherwise a
`draft`. Force one with `submitComplaint(input, { mode: "api" | "draft" })`. **Your calling code does
not change when the key arrives** — set the env var and `status` flips from `draft` to `filed`.

## Getting a production API key (required to file real requests)

Toronto grants Open311 keys manually. Until you have one, the API backend refuses to POST and
`submitComplaint` returns a `draft` (the server runs read-only).

1. **Request a key:** the old self-serve form (`webwizard/start.jsp`) is **retired (404)**. Email the
   **City of Toronto Open Data team at <opendata@toronto.ca>** (≈2 business-day reply), or call 311
   (416-392-2489 from outside Toronto), and ask for Open311 / GeoReport v2 developer access — a
   **test and a production key** if offered.
2. **In your request, explicitly ask the City for:**
   - the **list of enabled `service_code`s** (the public channel historically only allows a
     limited set — e.g. graffiti and potholes — not the full 311 catalogue);
   - confirmation of the **production base URL** (`https://secure.toronto.ca/webwizard/ws`);
   - whether your **server's egress IP needs allow-listing** — calls are fronted by Akamai and
     return `HTTP 403 Access Denied` from unrecognized networks.
3. **Reference docs:** City developer page —
   <https://www.toronto.ca/home/311-toronto-at-your-service/open311-api-and-mobile-apps/information-for-developers-open311-api/>
   · Open311 spec — <https://wiki.open311.org/GeoReport_v2/>
4. When the key arrives, set `TORONTO_311_API_KEY` and point `TORONTO_311_BASE_URL` at production.

## Browser pre-fill (experimental, human-in-the-loop)

Since the API needs a key we may not have, [`scripts/prefill-pothole.mts`](scripts/prefill-pothole.mts)
drives the **public web form** with Playwright as a fallback. It pre-fills everything it reliably can,
then **hands off to a human** for the two things automation legitimately cannot do — confirming the
map-pin location and solving the invisible reCAPTCHA. **It never submits.**

```bash
npx tsx scripts/prefill-pothole.mts            # built-in sample issue
npx tsx scripts/prefill-pothole.mts issue.json # your own issue
```

The form is a multi-step Salesforce Lightning wizard:

```
outer SPA : deep link → concern dropdown → 3 qualifying radios → Start
inner form: 1 Terms → 2 Location[HUMAN: pin] → 3 Request Details → 4 Contact → 5 Review[HUMAN: reCAPTCHA + Submit]
```

**Caveats — this is a brittle spike, not production:**
- Selectors target Salesforce shadow DOM and **will break** when the City changes the flow.
- Steps **1–6 (through typing the address) are verified**; the auto-fill on Steps 3–4 is best-effort
  and only runs once the human crosses the Step-2 map-pin gate — if a field isn't found it tells the
  human to enter it manually (it never writes into the wrong box).
- Fully-unattended filing is **not possible** (reCAPTCHA + map geocode) and not attempted.
- For real automation, prefer the API key below — this is a single-user convenience only.

## Known constraints

- **Limited scope:** only the City-enabled `service_code`s can be filed. Verify with
  `list_service_types` against your keyed production endpoint before promising categories to users.
- **Edge protection:** requests from unrecognized IPs get an Akamai `403`. The server detects this
  and returns a clear message rather than raw HTML.
- **Test vs production:** the sandbox (`/open311test/ws`) is for development; it does not create
  real work orders.
