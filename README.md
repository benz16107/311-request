# toronto-311-prefill

A headed, **human-in-the-loop** Playwright script that pre-fills the City of Toronto's public
311 web form for a **"Road Pothole / Road Damage"** service request, then hands off to a human
for the two things automation can't do — confirming the map-pin location and solving the
invisible reCAPTCHA. **It never submits.**

Everything lives in [`scripts/prefill-pothole.mts`](scripts/prefill-pothole.mts).

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
  "description": "Large pothole in the curb lane, ~40cm wide.",
  "reporter": { "firstName": "Ben", "email": "you@example.com" }
}
```

## How it works

```
outer SPA : deep link → concern dropdown → 3 qualifying radios → Start
inner form: 1 Terms → 2 Location[HUMAN: pin] → 3 Request Details → 4 Contact → 5 Review[HUMAN: reCAPTCHA + Submit]
```

The script deep-links past the category click-through, selects the concern, answers the
qualifying questions, accepts the Terms, and types/geocodes the address — then waits for you to
confirm the map pin. It resumes to fill description/contact and stops at Review for you to solve
the reCAPTCHA and submit.

## Caveats

- **Brittle by nature:** the form is a multi-step Salesforce Lightning wizard (shadow DOM);
  selectors will break when the City changes the flow.
- Steps **1–6 (through typing the address) are verified**; the Step 3–4 auto-fill is best-effort
  and only runs after you cross the map-pin gate — unfound fields fall back to "enter manually"
  rather than writing into the wrong box.
- **Fully-unattended filing is not possible** (reCAPTCHA + map geocode) and not attempted.
- The City's official **Open311 API** is the only clean automated path, but it requires a
  manually-issued API key + egress-IP allow-listing (email <opendata@toronto.ca>).
