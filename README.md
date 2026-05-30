# toronto-311-mcp

A single-file MCP server that wraps the City of Toronto's **Open311 GeoReport v2** API so an
LLM/agent can discover, file, and track 311 service requests (e.g. graffiti, potholes).

All logic lives in [`mcp.ts`](mcp.ts). The Open311 client is decoupled from the MCP wiring, so
you can lift it into an HTTP MCP server or a worker unchanged.

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

## Getting a production API key (required to file real requests)

Toronto grants Open311 keys manually. Until you have one, `file_service_request` will refuse to
POST and the server runs read-only.

1. **Request a key:** open <https://secure.toronto.ca/webwizard/start.jsp?_wiz_id=API_key_request>
   and complete the form. Ask for **both a test and a production key** if offered.
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

## Known constraints

- **Limited scope:** only the City-enabled `service_code`s can be filed. Verify with
  `list_service_types` against your keyed production endpoint before promising categories to users.
- **Edge protection:** requests from unrecognized IPs get an Akamai `403`. The server detects this
  and returns a clear message rather than raw HTML.
- **Test vs production:** the sandbox (`/open311test/ws`) is for development; it does not create
  real work orders.
