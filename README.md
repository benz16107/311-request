# toronto-311-prefill

A headed, **human-in-the-loop** Playwright script that pre-fills the City of Toronto's public
311 web form for a **"Road Pothole / Road Damage"** service request, then hands off to a human
for the two things automation can't do — confirming the map-pin location and solving the
invisible reCAPTCHA. **It never submits.**

Everything lives in [`prefill-pothole.mts`](prefill-pothole.mts).

## Run

```bash
npm install
npx playwright install chromium      # one-time browser download
npm run prefill                      # built-in sample issue
npm run prefill -- issue.json        # your own issue (shape below)
```

Env:
- `HEADLESS=1` — run without a window (won't get past the map-pin step).
- `HANDOFF_TIMEOUT_MS` — how long to wait for the human at each handoff (default 300000).

## Issue file

```json
{
  "concern": "Road Pothole / Road Damage",
  "onTorontoIsland": "No",
  "roadType": "Road",
  "inBikeLane": "No",
  "address": "100 Queen St W, Toronto",
  "exactLocation": "Northbound curb lane, ~10m south of Queen St W and York St.",
  "description": "Large pothole in the curb lane, about 40cm wide.",
  "majorRoad": "Yes",
  "additionalInfo": "",
  "reporter": { "firstName": "Ben", "lastName": "Zhou", "email": "you@example.com", "phone": "416-555-0199" }
}
```

Free-text fields (`exactLocation`, `description`, `additionalInfo`) are auto-sanitized — disallowed
characters (e.g. `~`, `#`, `*`) are stripped and text is capped at 255 chars, since the form rejects
anything outside `a–z 0–9 space ( ) @ , ' & / ? - : .`

## How it works

```
outer SPA : deep link → concern dropdown → 3 qualifying radios → Start
inner form: 1 Terms → 2 Location[auto-pick address; human fallback] → 3 Request Details → 4 Contact → 5 Review[HUMAN: reCAPTCHA + Submit]
```

The script deep-links past the category click-through, selects the concern, answers the
qualifying questions, and accepts the Terms. On the Location step it types the address, waits for
Toronto's geocoder autocomplete, and **clicks the first matching suggestion** (which drops the map
pin) — then advances automatically. It fills description/contact and stops at Review for you to
solve the reCAPTCHA and submit. If the geocoder returns no suggestion, it hands off so you can pick
the address / confirm the pin, then resumes.

## Caveats

- **Brittle by nature:** the form is a multi-step Salesforce Lightning wizard (shadow DOM);
  selectors will break when the City changes the flow.
- Steps **1–6 (through typing the address) are verified**; the address auto-pick and Step 3–4
  auto-fill are best-effort — unfound fields fall back to "enter manually" rather than writing into
  the wrong box.
- The address autocomplete uses Toronto's geocoder (`api.toronto.ca/cotgeocoder`), which is **blocked
  from data-center / unrecognized networks** (returns HTTP 400, same edge protection as the Open311
  API). From such a network no suggestions appear and the script hands the address step to a human;
  from a normal residential connection it auto-picks.
- **Fully-unattended filing is not possible** (reCAPTCHA + map geocode) and not attempted.
- The City's official **Open311 API** is the only clean automated path, but it requires a
  manually-issued API key + egress-IP allow-listing (email <opendata@toronto.ca>).
