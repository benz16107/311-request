/**
 * Headed, human-in-the-loop pre-fill for a Toronto 311 "Road Pothole / Road
 * Damage" service request. The robot does the tedious wizard navigation and
 * pre-fills every field it reliably can; a human handles the two things
 * automation legitimately can't: confirming the map-pin location and solving
 * the invisible reCAPTCHA at submit. The script NEVER submits.
 *
 *   npx tsx prefill-pothole.mts [issue.json]
 *
 *   HEADLESS=1            run without a window (won't get past the map step)
 *   HANDOFF_TIMEOUT_MS=…  how long to wait for the human at each handoff (def 300000)
 *
 * Flow (see README "Browser pre-fill"):
 *   outer SPA:  deep link -> concern -> 3 qualifying radios -> Start
 *   inner form: 1 Terms -> 2 Location[auto-pick address; human pin fallback]
 *               -> 3 Request Details -> 4 Contact -> 5 Review[HUMAN reCAPTCHA + Submit]
 *
 * Brittleness: the inner form is Salesforce Lightning (shadow DOM). Steps 1-7
 * and the Step-3/4 field selectors are best-effort and WILL need updating when
 * the City changes the flow; unfound fields fall back to "fill this yourself".
 */
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

// Deep link straight to the pothole/road form (skips the category click-through).
const FORM =
  "https://www.toronto.ca/home/311-toronto-at-your-service/create-a-service-request/service-request/?request=0VS6g000000DzbXGAS";

type PotholeIssue = {
  concern: string;
  onTorontoIsland: "Yes" | "No";
  roadType: "Road" | "Expressway";
  inBikeLane: "Yes" | "No";
  address: string;
  description: string;
  reporter?: { firstName?: string; lastName?: string; email?: string; phone?: string };
};

const DEFAULT_ISSUE: PotholeIssue = {
  concern: "Road Pothole / Road Damage",
  onTorontoIsland: "No",
  roadType: "Road",
  inBikeLane: "No",
  address: "100 Queen St W, Toronto",
  description: "Large pothole in the curb lane, ~40cm wide, deep enough to jolt a car.",
  reporter: { firstName: "Ben", email: "benz16107@gmail.com" },
};

const issuePath = process.argv[2];
const ISSUE: PotholeIssue = issuePath ? { ...DEFAULT_ISSUE, ...JSON.parse(readFileSync(issuePath, "utf8")) } : DEFAULT_ISSUE;
const HANDOFF_MS = Number(process.env.HANDOFF_TIMEOUT_MS ?? 300000);

const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 2600 } });
const page = await ctx.newPage();

const banner = (s: string) => console.log(`\n${"─".repeat(60)}\n${s}\n${"─".repeat(60)}`);

async function answerRadio(page: Page, qFragment: string, option: string) {
  const fs = page.locator("fieldset").filter({ hasText: qFragment }).first();
  if (await fs.count()) {
    await fs.getByText(option, { exact: true }).first().click({ timeout: 5000 });
    console.log(`  ✓ "${qFragment}" → ${option}`);
  } else console.log(`  ✗ question not found: "${qFragment}"`);
}

/**
 * Wait for the inner wizard to reach "Step N: <name>". We match the page
 * HEADING only (role=heading) — the step stepper repeats every step's label in
 * the DOM at all times, so a plain getByText would match immediately and skip
 * the human handoff. The active step's number appears only in the heading.
 */
async function waitForStep(n: number, name: string): Promise<boolean> {
  try {
    await page
      .getByRole("heading")
      .filter({ hasText: new RegExp(`Step ${n}:\\s*${name}`, "i") })
      .first()
      .waitFor({ timeout: HANDOFF_MS });
    return true;
  } catch {
    console.log(`  …did not reach "Step ${n}: ${name}" (human handoff not completed) — skipping auto-fill.`);
    return false;
  }
}

/** Best-effort fill; if the field isn't found, tell the human to enter it. */
async function tryFill(locator: ReturnType<Page["locator"]>, value: string | undefined, label: string) {
  if (!value) return;
  if (await locator.count()) {
    await locator.first().fill(value).catch(() => {});
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} field not found — enter manually: ${JSON.stringify(value)}`);
  }
}

/**
 * Type the address and click the geocoder's first matching suggestion (which
 * drops the map pin and validates the location). Returns true if a suggestion
 * was clicked. Suggestions come from Toronto's geocoder
 * (api.toronto.ca/cotgeocoder); if it returns nothing — the network is
 * edge-blocked, the service is down, or there's no match — this returns false
 * and the caller falls back to a human handoff.
 */
async function selectAddress(value: string): Promise<boolean> {
  const addr = page.getByLabel("Address, Intersection, Park Name or Landmark").first();
  if (!(await addr.count())) { console.log("  ✗ address field not found"); return false; }
  await addr.click();
  await addr.fill("");
  await addr.pressSequentially(value, { delay: 120 }); // per-keystroke typing triggers the autocomplete

  const options = page.getByRole("option");
  try {
    await options.first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    console.log("  ⚠ no address suggestions appeared (geocoder unreachable here, or no match)");
    await page.getByRole("button", { name: /find address/i }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return false;
  }

  // Prefer a suggestion containing the street part; otherwise take the first (best match).
  const street = value.split(",")[0].trim();
  let target = options.filter({ hasText: street }).first();
  if (!(await target.count())) target = options.first();
  const text = (await target.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  await target.click();
  console.log(`  ✓ picked address suggestion: ${text || street}`);
  await page.waitForTimeout(2500); // let the pin drop / location validate
  return true;
}

try {
  console.log("issue:", issuePath ? `(from ${issuePath})` : "(built-in sample)");

  console.log("\n1. deep-link to pothole form…");
  await page.goto(FORM, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(7000);

  console.log("2. select concern + Continue…");
  await page.getByLabel(/what is the concern/i).first().selectOption({ label: ISSUE.concern });
  await page.getByRole("button", { name: /continue/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(6000);

  console.log("3. answer qualifying questions…");
  await answerRadio(page, "Toronto Island", ISSUE.onTorontoIsland);
  await answerRadio(page, "road or expressway", ISSUE.roadType);
  await answerRadio(page, "bike lane", ISSUE.inBikeLane);

  console.log("4. Start your Request…");
  await page.getByRole("button", { name: /start your request/i }).first().click({ timeout: 8000 });
  await page.waitForTimeout(9000);

  console.log("5. accept Terms of Use…");
  const cb = page.getByRole("checkbox").first();
  if (await cb.count()) { await cb.check({ timeout: 5000 }).catch(() => cb.click()); console.log("  ✓ agreed"); }
  await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(6000);

  console.log("6. fill location + auto-pick address suggestion…");
  await selectAddress(ISSUE.address);

  // If the geocoder validated the address (dropped the pin), Next advances to
  // Step 3 with no human needed. Otherwise, hand off to confirm the pin.
  await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const onStep3 = (await page.getByRole("heading").filter({ hasText: /Step 3/i }).first().count()) > 0;
  if (onStep3) {
    console.log("  ✓ address auto-confirmed — advanced to Request Details");
  } else {
    banner(
      "ACTION NEEDED (human):\n" +
        "  • The address wasn't auto-confirmed (geocoder returned no suggestion, or\n" +
        "    the map pin needs confirming). In the open browser, pick the address\n" +
        "    suggestion / confirm the pin, then click Next.\n" +
        "  The script will resume and fill the rest automatically.",
    );
  }

  // 7. Resume on Request Details → fill description
  if (await waitForStep(3, "Request Details")) {
    console.log("7. fill description…");
    // Target a labelled description field (not just "first visible textarea",
    // which on other steps would be the wrong box).
    const desc = page.getByLabel(/describ|provide details|details of your request|tell us|what.*happen|comment/i).first();
    await tryFill(desc, ISSUE.description, "description");
    await page.waitForTimeout(500);
    banner("Description filled. Review it, then click Next to continue to Contact.");
  }

  // 8. Resume on Contact → pre-fill reporter details
  if (await waitForStep(4, "Contact")) {
    console.log("8. pre-fill contact…");
    await tryFill(page.getByLabel(/first name/i), ISSUE.reporter?.firstName, "first name");
    await tryFill(page.getByLabel(/last name/i), ISSUE.reporter?.lastName, "last name");
    await tryFill(page.getByLabel(/email/i), ISSUE.reporter?.email, "email");
    await tryFill(page.getByLabel(/phone/i), ISSUE.reporter?.phone, "phone");
    banner("Contact pre-filled. Click Next to reach Review & Submit.");
  }

  // 9. Stop at Review & Submit — the human solves reCAPTCHA and submits.
  if (await waitForStep(5, "Review")) {
    banner(
      "FINAL STEP (human):\n" +
        "  • Review everything.\n" +
        "  • Solve the reCAPTCHA and click Submit yourself.\n" +
        "  This script will NOT submit. Close the window when done.",
    );
  }

  if (process.env.HEADLESS !== "1") await page.waitForTimeout(HANDOFF_MS);
} catch (e) {
  console.log("ERROR:", (e as Error).message.split("\n")[0]);
  await page.screenshot({ path: "/tmp/311-prefill-error.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
