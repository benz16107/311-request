# toronto-311-prefill

A headed, **human-in-the-loop** Playwright script that pre-fills the City of Toronto's public
311 web form for a **"Road Pothole / Road Damage"** service request, then hands off to a human
for the two things automation can't do — confirming the map-pin location and solving the
invisible reCAPTCHA. **It never submits.**

Everything lives in [`prefill-pothole.mts`](prefill-pothole.mts) — one file, runnable as a
CLI or importable as a module (see [Use as a module](#use-as-a-module)).

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

## Use as a module

The same single file is import-safe: **importing it runs nothing** — call `prefillPothole`
to start. It opens the browser, fills through to Review, waits for the human, then closes,
and returns a result (it never throws — failures land in `result.error`):

```ts
import { prefillPothole, DEFAULT_ISSUE } from "./prefill-pothole.mts";

const result = await prefillPothole(
  { ...DEFAULT_ISSUE, address: "250 Yonge St, Toronto" },
  { headless: false, handoffMs: 300_000 },
);
// result: { reachedReview, addressAutoConfirmed, error? }
if (!result.reachedReview) console.warn("needs attention:", result.error);
```

Exports: `prefillPothole(issue, opts?)`, `DEFAULT_ISSUE`, and the types `PotholeIssue`,
`PrefillOptions`, `PrefillResult`.

To call it from other software, that project must list **`playwright` as a dependency**
(it's only a devDependency here) and run `npx playwright install chromium` once in its own
environment — the browser binary isn't carried by this file.

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
  "shoeBoxOrLarger": "Yes",
  "additionalInfo": "",
  "photos": ["./pothole.jpg", "/abs/path/closeup.png"],
  "anonymous": false,
  "reporter": {
    "firstName": "Ben",
    "lastName": "Zhou",
    "initial": "",
    "email": "you@example.com",
    "phone": "416-555-0199",
    "extension": "",
    "deviceType": "Mobile",
    "smsUpdates": true,
    "emailUpdates": true
  }
}
```

Set `"anonymous": true` to tick the form's **"file anonymously"** box and skip every contact
field — `reporter` is then ignored. With `"anonymous": false` (the default) the Contact step fills
First/Last/Initial name, Primary Contact Number (`phone`) + Extension, the Primary Device Type
dropdown, Email, and ticks the SMS/Email boxes under **Preferred Notification Channels** per
`smsUpdates`/`emailUpdates`.

Free-text fields (`exactLocation`, `description`, `additionalInfo`) are auto-sanitized — disallowed
characters (e.g. `~`, `#`, `*`) are stripped and text is capped at 255 chars, since the form rejects
anything outside `a–z 0–9 space ( ) @ , ' & / ? - : .`

`photos` is an optional list of **one or more** file paths (absolute, or relative to the working
directory) attached on the **Request Details** step, where the form shows *"Upload photos / files
(maximum of 5)"*. Paths are validated against the form's rules first — allowed types **jpeg, png, jpg,
gif, xls(x), doc(x), pdf**, **≤10 MB each**, **max 5 files** — and anything failing a rule is skipped
with a warning rather than aborting the run. The uploader is Dropzone.js; the script sets the files on
its hidden file input (falling back to clicking *"Add photos / files"* and answering the OS picker),
then advances as soon as the file(s) are attached — it does **not** wait for the background upload to
finish. If no mechanism works it logs a manual-attach fallback and never blocks. When photos are
configured, `result.photosAttached` reports whether at least one file was attached. Stuck? Re-run with
`DEBUG_FIELDS=1` to dump the upload widget's structure.

## How it works

```
outer SPA : deep link → concern dropdown → 3 qualifying radios → Start
inner form: 1 Terms → 2 Location[auto-pick address; human fallback] → 3 Request Details[+ optional photos] → 4 Contact → 5 Review[HUMAN: reCAPTCHA + Submit]
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
