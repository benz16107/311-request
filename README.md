# toronto-311-prefill

A headed, **human-in-the-loop** Playwright script that pre-fills the City of Toronto's public
311 web form for a **"Road Pothole / Road Damage"** service request, then hands off to a human
for the two things automation can't do — confirming the map-pin location and solving the
invisible reCAPTCHA. **It never submits.**

Everything lives in [`prefill-pothole.mts`](prefill-pothole.mts) — one file, runnable as a
CLI or importable as a module (see [Connect your service](#connect-your-service)).

## Run

```bash
npm install
npx playwright install chromium      # one-time browser download
npm run prefill                      # built-in sample issue (DEFAULT_ISSUE)
npm run prefill -- issue.json        # your own issue (shape below)
```

Env:
- `HEADLESS=1` — run without a window (won't get past the map-pin step).
- `HANDOFF_TIMEOUT_MS` — how long to wait for the human at each handoff, in ms (default `300000`).
- `DEBUG_FIELDS=1` — dump field/upload-widget selectors to the log to debug a broken step.

## Connect your service

Your service hands this script **one issue object** and it drives the browser to the Review
step. There are two ways to wire it in. **Importing the function is the recommended path** —
it's the only one that returns a structured result your code can branch on.

### Option A — import the function (returns a structured result)

`prefill-pothole.mts` is import-safe: **importing it runs nothing** — you call `prefillPothole`
to start. It opens the browser, fills through to Review, waits for the human, then closes. It
**never throws** — any failure lands in `result.error`.

```ts
import { prefillPothole, DEFAULT_ISSUE, type PotholeIssue } from "./prefill-pothole.mts";

const issue: PotholeIssue = {
  concern: "Road Pothole / Road Damage",
  onTorontoIsland: "No",
  roadType: "Road",
  inBikeLane: "No",
  address: "100 Queen St W, Toronto",
  exactLocation: "Northbound curb lane, ~10m south of Queen St W and York St.",
  description: "Large pothole in the curb lane, about 40cm wide.",
  majorRoad: "Yes",
  shoeBoxOrLarger: "Yes",
  photos: ["/abs/path/pothole.jpg"],            // optional
  reporter: {
    firstName: "Ada", lastName: "Lovelace", email: "ada@example.com",
    phone: "416-555-0100", deviceType: "Mobile", smsUpdates: true, emailUpdates: true,
  },
};

const result = await prefillPothole(issue, { headless: false, handoffMs: 300_000 });
// result: { reachedReview, addressAutoConfirmed, photosAttached?, error? }
if (!result.reachedReview) myService.flagForOperator(result.error);
```

`prefillPothole(issue, opts?)` takes a **complete** `PotholeIssue` — unlike the CLI it does
**not** auto-merge `DEFAULT_ISSUE`. Pass every field, or spread the sample:
`prefillPothole({ ...DEFAULT_ISSUE, address, exactLocation, reporter })`.

`opts`: `{ headless?: boolean (default false), handoffMs?: number (default 300000) }`. Headless
can't clear the map-pin step, so leave it `false` for real filings.

The result your service gets back:

| Field | Type | Meaning |
| --- | --- | --- |
| `reachedReview` | boolean | Every field filled and stopped at Step 5 (Review). The success signal. |
| `addressAutoConfirmed` | boolean | The geocoder auto-picked the address (no human pin needed). |
| `photosAttached` | boolean? | Present only when `issue.photos` was non-empty: did ≥1 file attach? |
| `error` | string? | First line of the error if the flow threw (it otherwise never throws). |

Exports: `prefillPothole`, `DEFAULT_ISSUE`, and the types `PotholeIssue`, `PrefillOptions`,
`PrefillResult`.

To import from another project, that project must list **`playwright` as a dependency** (it's
only a devDependency here) and run `npx playwright install chromium` once in its own
environment — the browser binary isn't carried by this file.

### Option B — spawn the CLI (subprocess)

Write the issue to a JSON file and run the CLI, passing the **file path as the one positional
argument** and the two knobs as **env vars**:

```js
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

writeFileSync("/tmp/issue.json", JSON.stringify(issue));

execFile(
  "npx",
  ["tsx", "prefill-pothole.mts", "/tmp/issue.json"],   // arg = path to your issue JSON
  {
    cwd: "/path/to/toronto-311-prefill",
    env: { ...process.env, HANDOFF_TIMEOUT_MS: "300000" }, // HEADLESS=1 to run windowless
  },
  (err, stdout, stderr) => { /* progress is human-readable text on stdout */ },
);
```

CLI specifics your service should know:
- **Shallow-merged with `DEFAULT_ISSUE`.** The CLI does `{ ...DEFAULT_ISSUE, ...yourJSON }`, so
  any **top-level** key you omit falls back to the sample. The merge is *not* deep: if you
  include `reporter`, your object **fully replaces** the default reporter — list every reporter
  field you want, or you'll inherit nothing from the sample for the ones you drop.
- **No machine-readable result.** The CLI prints progress text (`✓`/`✗`/`⚠` lines); it does
  **not** emit the `PrefillResult`. Exit code is `0` on a normal run and `1` only for a missing
  or unparseable issue file. If you need `reachedReview`/`photosAttached` to branch on, use
  Option A. On an internal error the CLI also writes `/tmp/311-prefill-error.png`.

Either way the run is **interactive**: a real human must confirm the map pin (when the geocoder
can't) and solve the reCAPTCHA in the open window. Budget `handoffMs`/`HANDOFF_TIMEOUT_MS` for
that, and don't spawn it on a headless server expecting an unattended filing — see [Caveats](#caveats).

## Issue parameters

The exact object your service passes (TypeScript type `PotholeIssue`). "Required" = the form
won't advance without it; the import path needs you to supply these (the CLI backfills missing
**top-level** ones from `DEFAULT_ISSUE`).

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `concern` | string | ✅ | Must match a "What is the concern?" option. For this form: `"Road Pothole / Road Damage"`. |
| `onTorontoIsland` | `"Yes"`\|`"No"` | ✅ | Qualifying radio. |
| `roadType` | `"Road"`\|`"Expressway"` | ✅ | Qualifying radio. |
| `inBikeLane` | `"Yes"`\|`"No"` | ✅ | Qualifying radio. |
| `address` | string | ✅ | "Address, Intersection, Park Name or Landmark" — fed to Toronto's geocoder autocomplete, e.g. `"100 Queen St W, Toronto"`. Must be a real **street address / intersection / landmark, not lat/lng coordinates** — the geocoder only matches place names. |
| `exactLocation` | string | ✅ | Distance from the intersection, side of road, landmarks. Sanitized, ≤255 chars. |
| `description` | string | ✅ | "Describe the size and depth of the road damage." Sanitized, ≤255 chars. |
| `majorRoad` | `"Yes"`\|`"No"` | ✅ | "Is the road damage on a major road?" dropdown. |
| `shoeBoxOrLarger` | `"Yes"`\|`"No"` | ✅ | "…size of a shoe box or larger?" dropdown. |
| `additionalInfo` | string | ⬜ | Optional free text. Sanitized, ≤255 chars. |
| `photos` | string[] | ⬜ | Paths to attach on Request Details (see [below](#photos)). |
| `anonymous` | boolean | ⬜ (def `false`) | `true` → tick "file anonymously" and skip `reporter` entirely. |
| `reporter` | object | ⬜ | Contact details, used only when `anonymous` is `false`. Fields below. |
| `reporter.firstName` | string | ⬜ | |
| `reporter.lastName` | string | ⬜ | |
| `reporter.initial` | string | ⬜ | |
| `reporter.email` | string | ⬜ | The form **requires** it once a notification channel is on, so set it if `smsUpdates`/`emailUpdates`. |
| `reporter.phone` | string | ⬜ | "Primary Contact Number". |
| `reporter.smsPhone` | string | ⬜ | "SMS Phone Number" — a separate field the form **requires** once an SMS channel is picked. Defaults to `phone` if omitted. |
| `reporter.extension` | string | ⬜ | "Primary Extension Number". |
| `reporter.deviceType` | string | ⬜ | "Primary Device Type" dropdown, e.g. `"Mobile"`. |
| `reporter.smsUpdates` | boolean | ⬜ | Tick the SMS box under "Preferred Notification Channels". |
| `reporter.emailUpdates` | boolean | ⬜ | Tick the Email box under "Preferred Notification Channels". |

Example `issue.json`:

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
    "smsPhone": "416-555-0199",
    "extension": "",
    "deviceType": "Mobile",
    "smsUpdates": true,
    "emailUpdates": true
  }
}
```

> The sample `phone`/`smsPhone` use the reserved fictitious `555-01xx` range — replace with a
> real number, or the City may reject the filing.

**Anonymous filing.** Set `"anonymous": true` to tick the form's **"file anonymously"** box and
skip every contact field — `reporter` is then ignored.

**Free-text sanitization.** `exactLocation`, `description`, and `additionalInfo` are auto-sanitized
— disallowed characters (e.g. `~`, `#`, `*`) are stripped and text is capped at 255 chars, since
the form rejects anything outside `a–z 0–9 space ( ) @ , ' & / ? - : .` (so `~40cm` becomes `40cm`).

<a id="photos"></a>**Photos.** `photos` is an optional list of **one or more** file paths
(absolute, or relative to the working directory) attached on the **Request Details** step, where
the form shows *"Upload photos / files (maximum of 5)"*. Paths are validated against the form's
rules first — allowed types **jpeg, png, jpg, gif, xls(x), doc(x), pdf**, **≤10 MB each**, **max 5
files** — and anything failing a rule is skipped with a warning rather than aborting the run. The
uploader is Dropzone.js; the script sets the files on its hidden file input (falling back to clicking
*"Add photos / files"* and answering the OS picker), then advances as soon as the file(s) are
attached — it does **not** wait for the background upload to finish. If no mechanism works it logs a
manual-attach fallback and never blocks. `result.photosAttached` reports whether at least one file
attached. Stuck? Re-run with `DEBUG_FIELDS=1` to dump the upload widget's structure.

## How it works

```
outer SPA : deep link → concern dropdown → 3 qualifying radios → Start
inner form: 1 Terms → 2 Location[auto-pick address; human fallback] → 3 Request Details[+ optional photos] → 4 Contact → 5 Review[HUMAN: reCAPTCHA + Submit]
```

The script deep-links past the category click-through, selects the concern, answers the
qualifying questions, and accepts the Terms. On the Location step it types the address, waits for
Toronto's geocoder autocomplete, and **clicks the first matching suggestion** (which drops the map
pin) — then advances automatically. It fills the request details + contact and stops at Review for
you to solve the reCAPTCHA and submit. If the geocoder returns no suggestion, it hands off so you
can pick the address / confirm the pin, then resumes.

The two required **Yes/No dropdowns** (major road, shoe box) are read back after setting and
retried via keyboard if the value didn't commit — Salesforce Lightning comboboxes silently no-op
otherwise. If a required Request Details field still won't take, the script says so immediately and
hands off (rather than appearing to hang) so a human can set it and click Next.

## Caveats

- **Brittle by nature:** the form is a multi-step Salesforce Lightning wizard (shadow DOM);
  selectors will break when the City changes the flow. Unfound fields fall back to "enter
  manually" rather than writing into the wrong box.
- Steps **1–6 (through typing the address) are verified**; the address auto-pick and Step 3–4
  auto-fill are best-effort.
- The address autocomplete uses Toronto's geocoder (`api.toronto.ca/cotgeocoder`), which is **blocked
  from data-center / unrecognized networks** (returns HTTP 400, same edge protection as the Open311
  API). From such a network no suggestions appear and the script hands the address step to a human;
  from a normal residential connection it auto-picks.
- **Fully-unattended filing is not possible** (reCAPTCHA + map geocode) and not attempted — so a
  service can pre-fill, but a human must finish each request in the open browser.
- The City's official **Open311 API** is the only clean automated path, but it requires a
  manually-issued API key + egress-IP allow-listing (email <opendata@toronto.ca>).
```