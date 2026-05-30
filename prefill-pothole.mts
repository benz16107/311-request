/**
 * Headed, human-in-the-loop pre-fill for a Toronto 311 "Road Pothole / Road
 * Damage" service request. The robot does the tedious wizard navigation and
 * pre-fills every field it reliably can; a human handles the two things
 * automation legitimately can't: confirming the map-pin location and solving
 * the invisible reCAPTCHA at submit. The script NEVER submits.
 *
 * Single file, usable two ways — importing it does NOT auto-run anything:
 *   • CLI:          npx tsx prefill-pothole.mts [issue.json]
 *   • Programmatic: import { prefillPothole, DEFAULT_ISSUE } from "./prefill-pothole.mts";
 *                   const result = await prefillPothole(issue, { headless, handoffMs });
 *
 * CLI env:
 *   HEADLESS=1            run without a window (won't get past the map step)
 *   HANDOFF_TIMEOUT_MS=…  how long to wait for the human at each handoff (def 300000)
 *
 * Flow (see README "Browser pre-fill"):
 *   outer SPA:  deep link -> concern -> 3 qualifying radios -> Start
 *   inner form: 1 Terms -> 2 Location[auto-pick address; human pin fallback]
 *               -> 3 Request Details[+ optional photo upload] -> 4 Contact
 *               -> 5 Review[HUMAN reCAPTCHA + Submit]
 *
 * Brittleness: the inner form is Salesforce Lightning (shadow DOM). Steps 1-7
 * and the Step-3/4 field selectors are best-effort and WILL need updating when
 * the City changes the flow; unfound fields fall back to "fill this yourself".
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page, type Locator } from "playwright";

// Deep link straight to the pothole/road form (skips the category click-through).
const FORM =
  "https://www.toronto.ca/home/311-toronto-at-your-service/create-a-service-request/service-request/?request=0VS6g000000DzbXGAS";

export type PotholeIssue = {
  concern: string;
  onTorontoIsland: "Yes" | "No";
  roadType: "Road" | "Expressway";
  inBikeLane: "Yes" | "No";
  address: string;
  // --- Request Details step ---
  exactLocation: string; // required: distance from intersection, landmarks, side of road
  description: string; // "Describe the size and depth of the road damage."
  majorRoad: "Yes" | "No"; // required dropdown: "Is the road damage on a major road?"
  shoeBoxOrLarger: "Yes" | "No"; // required dropdown: "…size of a shoe box or larger?"
  additionalInfo?: string; // optional
  photos?: string[]; // optional: paths to photo files of the damage to attach (absolute, or relative to cwd)
  // --- Contact step ---
  anonymous?: boolean; // tick "file anonymously" and skip all contact fields
  reporter?: {
    firstName?: string;
    lastName?: string;
    initial?: string;
    email?: string;
    phone?: string; // "Primary Contact Number"
    smsPhone?: string; // "SMS Phone Number" — required once an SMS channel is picked; defaults to phone
    extension?: string; // "Primary Extension Number"
    deviceType?: string; // "Primary Device Type" dropdown, e.g. "Mobile"
    smsUpdates?: boolean; // tick the SMS box under "Preferred Notification Channels"
    emailUpdates?: boolean; // tick the Email box under "Preferred Notification Channels"
  };
};

export const DEFAULT_ISSUE: PotholeIssue = {
  concern: "Road Pothole / Road Damage",
  onTorontoIsland: "No",
  roadType: "Road",
  inBikeLane: "No",
  address: "None",
  exactLocation: "",
  description: "",
  majorRoad: "Yes",
  shoeBoxOrLarger: "Yes",
  additionalInfo: "",
  anonymous: false,
  reporter: {
    firstName: "Name1",
    lastName: "Name2",
    email: "email@email.com",
    phone: "123-456-7890", // PLACEHOLDER (555-01xx is a reserved fictitious range) — replace with a real number
    deviceType: "Mobile",
    smsUpdates: true,
    emailUpdates: true,
  },
};

/** Options for {@link prefillPothole}. */
export type PrefillOptions = {
  headless?: boolean; // default false; headless can't clear the map-pin step
  handoffMs?: number; // how long to wait for the human at each handoff (default 300000)
};

/** What {@link prefillPothole} reports back to its caller. */
export type PrefillResult = {
  reachedReview: boolean; // true if every field was filled and we stopped at Step 5 (Review)
  addressAutoConfirmed: boolean; // true if the geocoder auto-picked the address (no human pin needed)
  photosAttached?: boolean; // set only when `issue.photos` was non-empty: did the upload succeed?
  error?: string; // first line of the error message if the flow threw
};

// Module-level handles the DOM helpers below close over. Assigned at the start of
// each prefillPothole() run. The flow is inherently serial (one human, one
// reCAPTCHA at a time), so a single shared page/timeout is fine.
let page: Page;
let HANDOFF_MS = 300000;

const banner = (s: string) => console.log(`\n${"─".repeat(60)}\n${s}\n${"─".repeat(60)}`);

/**
 * Wait (up to `ms`) for `loc` to be visible and return whether it appeared.
 * Replaces blind `waitForTimeout` sleeps: we wait exactly until the next thing
 * the script needs is on screen — no longer than necessary on a fast connection,
 * and no flaky "the sleep was too short" on a slow one.
 */
const settle = (loc: Locator, ms = 20000): Promise<boolean> =>
  loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);

async function answerRadio(page: Page, qFragment: string, option: string) {
  const fs = page.locator("fieldset").filter({ hasText: qFragment }).first();
  if (await fs.count()) {
    await fs.getByText(option, { exact: true }).first().click({ timeout: 5000 });
    console.log(`  ✓ "${qFragment}" → ${option}`);
  } else console.log(`  ✗ question not found: "${qFragment}"`);
}

/**
 * Wait for the inner wizard to reach step N. We match the page HEADING only
 * (role=heading) on the step NUMBER — the step stepper repeats every step's
 * label in the DOM at all times, so a plain getByText would match immediately
 * and skip the human handoff; the active step's number appears only in the
 * heading. We deliberately do NOT match on `name`: the City's wording for a
 * step varies (e.g. step 4 is headed "Person - Caller/Contact", not "Contact"),
 * and an over-specific name match silently skips the whole step. `name` is for
 * logging only.
 */
async function waitForStep(n: number, name: string): Promise<boolean> {
  try {
    await page
      .getByRole("heading")
      .filter({ hasText: new RegExp(`Step\\s*${n}\\b`, "i") })
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
 * The form's free-text fields reject anything outside this set (alphanumeric,
 * space, and  ( ) @ , ' & / ? - : .  ) and cap at 255 chars. Replace disallowed
 * characters with a space, collapse, and truncate — so e.g. "~40cm" → "40cm".
 */
function sanitize(s: string | undefined): string {
  return (s ?? "").replace(/[^A-Za-z0-9 ()@,'&/?:.\-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
}

/**
 * Best-effort select by label. Handles BOTH a native <select> and a Salesforce
 * Lightning combobox (a button/role=combobox that opens a listbox of
 * role=option items) — the City uses the latter for some dropdowns, and
 * selectOption only works on a real <select>.
 *
 * Every path VERIFIES the value actually committed before logging success. The
 * combobox needs this: step 3 has two Yes/No dropdowns (major road + shoe box),
 * so an unscoped getByRole("option", {name:"No"}).first() can click a stray,
 * hidden "No" from the OTHER dropdown — a silent no-op that leaves major road on
 * its placeholder, blocks Next, and used to look like a hang. We therefore click
 * the option in the listbox THIS combobox just opened, read the control back, and
 * fall back to keyboard entry if it didn't take.
 */
async function selectDropdown(labelRe: RegExp, value: string | undefined, label: string) {
  if (!value) return;
  const el = page.getByLabel(labelRe).first();
  const tag = (await el.count()) ? await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "") : "";

  // What the control currently displays — used to confirm the value stuck.
  const shownValue = async (loc: Locator): Promise<string> =>
    ((await loc.inputValue().catch(() => "")) || (await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const isSet = (shown: string) => new RegExp(`(^|\\b)${value}(\\b|$)`, "i").test(shown);

  if (tag === "select") {
    try { await el.selectOption({ label: value }); } catch { try { await el.selectOption(value); } catch {} }
    const selectedText = await el.evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text || "").catch(() => "");
    if (isSet(selectedText) || isSet(await shownValue(el))) { console.log(`  ✓ ${label} → ${value}`); return; }
    console.log(`  ✗ ${label}: option "${value}" not selectable — set it manually`);
    return;
  }

  // Lightning combobox: open it, click the matching option in the listbox it just
  // opened (NOT a global option match), then verify the value committed; retry by
  // keyboard if it didn't.
  const combo = (await el.count()) ? el : page.getByRole("combobox", { name: labelRe }).first();
  if (await combo.count()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await combo.scrollIntoViewIfNeeded().catch(() => {});
        await combo.click({ timeout: 5000 });
        // Exactly one listbox is visible once a combobox opens — scope to it so we
        // can't click the other Yes/No dropdown's hidden option by mistake.
        const open = page.locator('[role="listbox"]:visible').last();
        const scope = (await open.count().catch(() => 0)) ? open : page;
        const opt = scope.getByRole("option", { name: value, exact: true }).first();
        await opt.waitFor({ state: "visible", timeout: 4000 });
        await opt.click({ timeout: 4000 });
      } catch {}
      if (isSet(await shownValue(combo))) { console.log(`  ✓ ${label} → ${value}`); return; }
      // Keyboard fallback: focus the combobox, type the option, commit with Enter.
      try {
        await combo.click({ timeout: 4000 });
        await page.keyboard.type(value, { delay: 30 });
        await page.keyboard.press("Enter");
      } catch {}
      if (isSet(await shownValue(combo))) { console.log(`  ✓ ${label} → ${value} (keyboard)`); return; }
    }
    console.log(`  ✗ ${label}: clicked "${value}" but the dropdown still reads ${JSON.stringify(await shownValue(combo))} — set it manually`);
    return;
  }
  console.log(`  ✗ ${label} dropdown not found / "${value}" not selectable — set it manually`);
}

/** Tick/untick the "file anonymously" checkbox on the Contact step. */
async function setAnonymous(on: boolean) {
  const cb = page.getByRole("checkbox", { name: /anonymous/i }).first();
  if (!(await cb.count())) { console.log("  ✗ anonymous checkbox not found"); return; }
  if (on) {
    await cb.check({ timeout: 5000 }).catch(() => cb.click().catch(() => {}));
    console.log("  ✓ filing anonymously");
  } else {
    await cb.uncheck({ timeout: 5000 }).catch(() => {});
  }
}

/**
 * Tick an SMS/Email checkbox inside a named notification group. We scope to the
 * group so we don't accidentally hit the identical SMS/Email boxes in the
 * separate "Survey Preferred Notification Channels" section.
 */
async function checkChannel(groupFragment: string, channel: "SMS" | "Email") {
  const group = page.locator("fieldset, [role='group']").filter({ hasText: groupFragment }).first();
  const scope = (await group.count()) ? group : page;
  const re = new RegExp(`^\\s*${channel}\\s*$`, "i");
  const cb = scope.getByRole("checkbox", { name: re }).first();
  if (await cb.count()) {
    await cb.check({ timeout: 5000 }).catch(() => cb.click().catch(() => {}));
    console.log(`  ✓ ${groupFragment} → ${channel}`);
    return;
  }
  // Lightning sometimes hides the real <input>; click the visible label instead.
  const opt = scope.getByText(re).first();
  if (await opt.count()) {
    await opt.click().catch(() => {});
    console.log(`  ✓ ${groupFragment} → ${channel} (label)`);
    return;
  }
  console.log(`  ✗ ${groupFragment} → ${channel} checkbox not found`);
}

/**
 * Robust text fill for Salesforce Lightning inputs. A plain .fill() frequently
 * doesn't register with the framework — the field reads back blank and any
 * required-validation still fires — so we locate the field a few ways, type it
 * key-by-key, blur with Tab to commit, and read the value back to confirm it
 * actually stuck. `extra` locators are tried first (e.g. input[type=email]).
 */
async function robustFill(labelRe: RegExp, value: string | undefined, label: string, ...extra: Locator[]) {
  if (!value) return;
  const candidates = [...extra, page.getByLabel(labelRe), page.getByRole("textbox", { name: labelRe })];
  for (const loc of candidates) {
    // A label can resolve to several elements (Lightning often keeps a hidden
    // template input alongside the real one); .first() may grab the hidden one,
    // so walk every match and use the first that's actually visible & editable.
    for (const el of await loc.all()) {
      if (!(await el.isVisible().catch(() => false))) continue;
      if (!(await el.isEditable().catch(() => false))) continue;
      // A label like "first name" can also resolve to a nearby "single name"
      // CHECKBOX (id …singleNameCheck): clicking it toggles single-name mode and
      // breaks the real text input, and .fill() throws on a checkbox anyway.
      // Only ever fill genuine text inputs.
      const elType = ((await el.getAttribute("type").catch(() => "")) || "").toLowerCase();
      if (elType === "checkbox" || elType === "radio") continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click();
        await el.fill("");
        await el.pressSequentially(value, { delay: 20 }); // real keystrokes → Lightning registers input
        await el.press("Tab"); // blur commits the value (and clears required-validation)
        const got = (await el.inputValue().catch(() => "")).trim();
        if (got) { console.log(`  ✓ ${label} → ${got}`); return; }
      } catch {}
    }
  }
  console.log(`  ✗ ${label} field not found / didn't accept input — enter manually: ${JSON.stringify(value)}`);
}

/**
 * DEBUG (set DEBUG_FIELDS=1): dump every editable node's role + accessible name
 * exactly as Playwright sees it, so we can tell what a stubborn label (e.g.
 * "first name") is REALLY called on the live form. Uses the accessibility tree —
 * the same source getByRole/getByLabel match against — which includes shadow DOM.
 */
/**
 * DEBUG (set DEBUG_FIELDS=1): run at FILL TIME (fields rendered) to show which
 * selectors actually match the first-name input and to list the real visible
 * contact inputs. Built from getAttribute()/locator calls ONLY — passing a
 * function to page.evaluate trips tsx/esbuild's injected `__name` helper
 * (undefined in the browser), so we avoid evaluate and resolve labels via
 * locators. We first wait for the contact form (last name) so we don't snapshot
 * a half-rendered step.
 */
async function probeFirstName() {
  if (process.env.DEBUG_FIELDS !== "1") return;
  await page.getByLabel(/last name/i).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const probes: Array<[string, Locator]> = [
    ["getByLabel(/first name/i)", page.getByLabel(/first name/i)],
    ["getByPlaceholder(/first name/i)", page.getByPlaceholder(/first name/i)],
    ["getByRole textbox /first/i", page.getByRole("textbox", { name: /first/i })],
    ["input[name='firstName']", page.locator("input[name='firstName']")],
    ["input[name*='first' i]", page.locator("input[name*='first' i]")],
    ["input[id*='first' i]", page.locator("input[id*='first' i]")],
  ];
  for (const [desc, loc] of probes) console.log(`  probe ${desc} → count=${await loc.count().catch(() => -1)}`);
  // Per-match detail for the 2 getByLabel hits — find vs fill.
  const fl = page.getByLabel(/first name/i);
  const n = await fl.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = fl.nth(i);
    const vis = await el.isVisible().catch(() => null);
    const ed = await el.isEditable().catch(() => null);
    const id = (await el.getAttribute("id").catch(() => "")) || "";
    const bb = await el.boundingBox().catch(() => null);
    console.log(`  fn-label[${i}] visible=${vis} editable=${ed} box=${bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : "null"} id=${JSON.stringify(id)}`);
  }
  // Direct fill test by id suffix (the stable Salesforce field name).
  const byId = page.locator('input[id$="C311_First_Name__c"]').first();
  try {
    await byId.click();
    await byId.fill("");
    await byId.pressSequentially("TESTFN", { delay: 20 });
    await byId.press("Tab");
    console.log(`  byId fill → value=${JSON.stringify(await byId.inputValue().catch(() => "ERR"))}`);
  } catch (e) {
    console.log("  byId fill threw:", (e as Error).message.split("\n")[0]);
  }
  console.log("  -- visible text inputs at contact step --");
  for (const h of await page.locator("input, textarea").all()) {
    const type = ((await h.getAttribute("type").catch(() => "")) || "").toLowerCase();
    if (["hidden", "checkbox", "radio"].includes(type)) continue;
    if (!(await h.isVisible().catch(() => false))) continue;
    const nm = (await h.getAttribute("name").catch(() => "")) || "";
    const ph = (await h.getAttribute("placeholder").catch(() => "")) || "";
    const id = (await h.getAttribute("id").catch(() => "")) || "";
    const al = (await h.getAttribute("aria-label").catch(() => "")) || "";
    let lab = "";
    if (id) lab = ((await page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    console.log(`  vis-input name=${JSON.stringify(nm)} label=${JSON.stringify(lab)} aria=${JSON.stringify(al)} ph=${JSON.stringify(ph)} id=${JSON.stringify(id)}`);
  }
}

/**
 * Surface any visible <select> still left on its "Select" placeholder — i.e. a
 * required dropdown we haven't mapped yet — so unknown questions are named in
 * the log instead of silently blocking Next. (Playwright pierces shadow DOM.)
 */
async function reportUnsetDropdowns() {
  for (const s of await page.locator("select").all()) {
    if (!(await s.isVisible().catch(() => false))) continue;
    const info = await s
      .evaluate((el: HTMLSelectElement) => {
        const txt = (el.options[el.selectedIndex]?.text || "").trim();
        const unset = el.value === "" || txt === "" || /^select/i.test(txt);
        let label = el.getAttribute("aria-label") || "";
        if (!label && el.id) {
          const l = (el.getRootNode() as Document | ShadowRoot).querySelector?.(`label[for="${el.id}"]`);
          if (l) label = (l as HTMLElement).innerText.trim();
        }
        if (!label) { const w = el.closest("label"); if (w) label = (w as HTMLElement).innerText.trim(); }
        return { unset, label };
      })
      .catch(() => null);
    if (info?.unset && info.label) console.log(`  ⚠ unanswered required dropdown: "${info.label}" — add it to the issue file`);
  }
}

// The City's form: "Upload photos / files (maximum of 5). Only jpeg, png, jpg,
// gif, Microsoft Excel, Microsoft Word or pdf. Maximum 5 files. Max 10 MB each."
const PHOTO_ALLOWED = /\.(jpe?g|png|gif|xlsx?|docx?|pdf)$/i;
const PHOTO_MAX_FILES = 5;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Resolve, validate and cap the configured photo paths against the form's rules
 * (exists on disk, allowed extension, ≤10 MB, ≤5 files). Returns the absolute
 * paths worth attaching; anything rejected is logged and dropped rather than
 * aborting the run.
 */
function validatePhotos(paths: string[]): string[] {
  const ok: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) { console.log(`  ✗ photo not found, skipping: ${p}`); continue; }
    if (!PHOTO_ALLOWED.test(abs)) { console.log(`  ✗ type not allowed (jpeg/png/jpg/gif/xls/doc/pdf), skipping: ${basename(abs)}`); continue; }
    const size = statSync(abs).size;
    if (size > PHOTO_MAX_BYTES) { console.log(`  ✗ over 10 MB, skipping: ${basename(abs)} (${(size / 1048576).toFixed(1)} MB)`); continue; }
    ok.push(abs);
  }
  if (ok.length > PHOTO_MAX_FILES) {
    console.log(`  ⚠ form allows ${PHOTO_MAX_FILES} files — dropping: ${ok.slice(PHOTO_MAX_FILES).map((p) => basename(p)).join(", ")}`);
    ok.length = PHOTO_MAX_FILES;
  }
  return ok;
}

/**
 * DEBUG (set DEBUG_FIELDS=1): dump every file input and likely "upload" control
 * across all frames, so a stubborn uploader can be mapped from the logs. Same
 * spirit as probeFirstName — getAttribute/locator calls only, no page.evaluate.
 */
async function probeUpload() {
  if (process.env.DEBUG_FIELDS !== "1") return;
  console.log("  -- upload widget probe --");
  // Persist the raw step-3 DOM (every frame) + a screenshot so the upload widget
  // can be inspected offline and a selector pinned, instead of guessing blind.
  await page.screenshot({ path: "/tmp/311-step3.png", fullPage: true }).catch(() => {});
  const allFrames = page.frames();
  for (let i = 0; i < allFrames.length; i++) {
    const html = await allFrames[i].content().catch(() => "");
    if (html) writeFileSync(`/tmp/311-step3-frame-${i}.html`, html);
  }
  console.log(`  · dumped DOM → /tmp/311-step3.png and /tmp/311-step3-frame-0..${allFrames.length - 1}.html`);
  for (const fr of page.frames()) {
    const where = fr === page.mainFrame() ? "main" : `frame:${(fr.url() || "").slice(0, 50)}`;
    const inputs = fr.locator('input[type="file"]');
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      const [id, nm, acc, mult, vis] = [
        (await el.getAttribute("id").catch(() => "")) || "",
        (await el.getAttribute("name").catch(() => "")) || "",
        (await el.getAttribute("accept").catch(() => "")) || "",
        (await el.getAttribute("multiple").catch(() => null)) !== null,
        await el.isVisible().catch(() => null),
      ];
      console.log(`  [${where}] file-input[${i}] visible=${vis} multiple=${mult} accept=${JSON.stringify(acc)} name=${JSON.stringify(nm)} id=${JSON.stringify(id)}`);
    }
    for (const re of [/upload/i, /attach/i, /browse/i, /choose file/i, /add (a )?(photo|file)/i]) {
      const t = fr.getByText(re);
      const c = await t.count().catch(() => 0);
      for (let i = 0; i < Math.min(c, 3); i++) {
        const txt = ((await t.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (txt) console.log(`  [${where}] text~${re}: ${JSON.stringify(txt)}`);
      }
    }
  }
}

/**
 * Attach up to 5 photos/files of the damage on the Request Details step. The City's
 * uploader is Dropzone.js — a hidden <input type=file multiple class="dz-hidden-input">
 * alongside an "Add photos / files" button — and can live in the main document or a
 * frame. So we try, across every frame: (1) set the files straight onto the hidden
 * input (setInputFiles fires the change event Dropzone uploads on — no dialog, and no
 * ambiguity between the two identical buttons); (2) as a fallback, click the button
 * and answer the OS picker via Playwright's filechooser event. Either way we just
 * confirm the file(s) landed in the list and return — we do NOT wait for the upload
 * to finish, since the form lets you advance to the next step while it uploads in
 * the background.
 *
 * Returns true once at least one file is confirmed attached. Everything
 * is best-effort: invalid files are dropped (see {@link validatePhotos}), and if
 * no mechanism works it logs a manual-attach fallback (with a hint to re-run under
 * DEBUG_FIELDS=1) instead of throwing — same philosophy as the rest of the script.
 */
async function attachPhotos(paths: string[] | undefined): Promise<boolean> {
  if (!paths?.length) return false;
  const files = validatePhotos(paths);
  if (!files.length) { console.log("  ✗ no valid photo files to attach — set 'photos' to real, allowed file paths"); return false; }

  await probeUpload();
  const frames = page.frames();
  type Frame = ReturnType<Page["mainFrame"]>;

  // Confirm the file(s) landed in Dropzone's list — its file-name/preview renders
  // synchronously on the change event, so a short wait distinguishes the real
  // control from a decoy/hidden one. We do NOT wait for the upload to finish: the
  // form lets you advance while it uploads in the background, so blocking on the
  // (slow, for a large file) "File upload successful." line just wastes time. We
  // confirm IN THE SAME FRAME as the control (page.getByText can't see into an
  // iframe), keying off the file name — which only appears after a real selection,
  // never in the static instructions ("Upload photos / files", "uploaded", "10 MB").
  const confirm = async (fr: Frame, set: string[], how: string): Promise<boolean> => {
    const sign = fr.getByText(basename(set[0]), { exact: false }).or(fr.getByText(/uploading|file upload successful/i));
    if (!(await settle(sign, 10000))) return false; // didn't take — caller tries the next control
    if (set.length < files.length) console.log(`  ⚠ only ${set.length} file accepted here — add the rest manually: ${files.slice(set.length).map((p) => basename(p)).join(", ")}`);
    console.log(`  ✓ attached ${set.length} file(s)${how}: ${set.map((p) => basename(p)).join(", ")}`);
    return true;
  };

  // Strategy 1 (primary) — set the files straight onto the hidden <input type=file>
  // in any frame. The City's widget is Dropzone.js (input.dz-hidden-input, multiple):
  // setInputFiles dispatches the change event Dropzone listens for, so it starts the
  // upload with no dialog — and there's no ambiguity between the two "Add photos /
  // files" buttons. setInputFiles drives hidden inputs fine.
  for (const fr of frames) {
    const inputs = fr.locator('input[type="file"]');
    const cnt = await inputs.count().catch(() => 0);
    for (let i = 0; i < cnt; i++) {
      const el = inputs.nth(i);
      const multiple = (await el.getAttribute("multiple").catch(() => null)) !== null;
      const set = multiple ? files : files.slice(0, 1);
      try {
        await el.setInputFiles(set);
        if (await confirm(fr, set, "")) return true;
      } catch { /* hidden template / disabled slot — try the next input */ }
    }
  }

  // Strategy 2 (fallback) — click the "Add photos / files" button and answer the OS
  // file picker, which Playwright intercepts as a `filechooser` event. Covers any
  // widget that builds/clicks its <input> in JS rather than keeping a settable one.
  for (const fr of frames) {
    const candidates: Locator[] = [
      fr.getByRole("button", { name: /upload|attach|browse|choose|add (a )?(photo|file)/i }),
      fr.getByRole("link", { name: /upload|attach|browse/i }),
      fr.locator("label").filter({ hasText: /upload|attach|browse|choose file/i }),
      fr.getByText(/add (a )?(photo|file)|upload (photos|files)/i),
    ];
    for (const cand of candidates) {
      const count = await cand.count().catch(() => 0);
      // Try each match (the visible button may not be the first), preferring visible ones.
      for (let i = 0; i < count; i++) {
        const el = cand.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        try {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 8000 }),
            el.click({ timeout: 4000 }),
          ]);
          const set = chooser.isMultiple() ? files : files.slice(0, 1);
          await chooser.setFiles(set);
          if (await confirm(fr, set, " (via file picker)")) return true;
        } catch { /* not the trigger / no dialog opened — try the next match */ }
      }
    }
  }

  console.log(`  ✗ couldn't drive the photo upload automatically — attach manually: ${files.map((p) => basename(p)).join(", ")}`);
  console.log("     (re-run with DEBUG_FIELDS=1 to dump the upload widget so the selector can be fixed)");
  return false;
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
  // Speed: drop the bulk of the address in instantly with fill(), then type only
  // the last couple characters as real keystrokes. The geocoder's autocomplete
  // fires on those trailing keydowns (plus the input event fill() dispatches), so
  // we get the same suggestions without paying 120ms × every character.
  const tail = value.slice(-2);
  await addr.fill(value.slice(0, -2));
  await addr.pressSequentially(tail, { delay: 80 }); // trailing keystrokes trigger the autocomplete

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

/**
 * Pre-fill a Toronto 311 pothole request, headed and human-in-the-loop, and stop
 * at Review. Importing this file does NOT run anything — call this to start. The
 * browser stays open for the human (reCAPTCHA + Submit) until they finish or
 * `opts.handoffMs` elapses, then closes. NEVER submits. Returns what happened
 * (reached Review, was the address auto-confirmed, any error) so the caller can
 * react — it never throws; failures land in `result.error`.
 */
export async function prefillPothole(issue: PotholeIssue, opts: PrefillOptions = {}): Promise<PrefillResult> {
  HANDOFF_MS = opts.handoffMs ?? 300000;
  const headless = opts.headless ?? false;
  const result: PrefillResult = { reachedReview: false, addressAutoConfirmed: false };

  // Headed: maximize the window and let the page use its REAL on-screen size
  // (viewport: null) so there's a normal scrollbar — the human needs to scroll to
  // confirm the map pin and reach the reCAPTCHA/Submit. A fixed tall viewport
  // (the old 2600px) renders the whole page "within" the viewport with NO
  // scrollbar, leaving everything below the fold unreachable on a normal screen.
  // Playwright auto-scrolls to interact, so it doesn't need the page fully on
  // screen. Headless can't clear the map step anyway; give it a plain viewport.
  const browser = await chromium.launch({ headless, args: headless ? [] : ["--start-maximized"] });
  const ctx = await browser.newContext(headless ? { viewport: { width: 1280, height: 1000 } } : { viewport: null });
  page = await ctx.newPage();

  try {
    console.log("\n1. deep-link to pothole form…");
    await page.goto(FORM, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page.getByLabel(/what is the concern/i), 30000); // wait for the concern dropdown, not a flat 7s

    console.log("2. select concern + Continue…");
    await page.getByLabel(/what is the concern/i).first().selectOption({ label: issue.concern });
    await page.getByRole("button", { name: /continue/i }).first().click({ timeout: 8000 });
    await settle(page.locator("fieldset").filter({ hasText: /Toronto Island/i })); // wait for the qualifying questions

    console.log("3. answer qualifying questions…");
    await answerRadio(page, "Toronto Island", issue.onTorontoIsland);
    await answerRadio(page, "road or expressway", issue.roadType);
    await answerRadio(page, "bike lane", issue.inBikeLane);

    console.log("4. Start your Request…");
    await page.getByRole("button", { name: /start your request/i }).first().click({ timeout: 8000 });
    await settle(page.getByRole("checkbox"), 30000); // wait for the Terms step (its checkbox) to render

    console.log("5. accept Terms of Use…");
    const cb = page.getByRole("checkbox").first();
    if (await cb.count()) { await cb.check({ timeout: 5000 }).catch(() => cb.click()); console.log("  ✓ agreed"); }
    await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
    await settle(page.getByLabel("Address, Intersection, Park Name or Landmark")); // wait for the Location step

    console.log("6. fill location + auto-pick address suggestion…");
    await selectAddress(issue.address);

    // If the geocoder validated the address (dropped the pin), Next advances to
    // Step 3 with no human needed. Otherwise, hand off to confirm the pin.
    await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
    // Advance the instant Step 3 renders (auto-confirm worked); after 8s, hand off for the human pin.
    const onStep3 = await settle(page.getByRole("heading").filter({ hasText: /Step 3/i }), 8000);
    result.addressAutoConfirmed = onStep3;
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

    // 7. Request Details → fill the required fields, then advance
    if (await waitForStep(3, "Request Details")) {
      console.log("7. fill request details…");
      await tryFill(page.getByLabel(/exact location/i), sanitize(issue.exactLocation), "exact location (required)");
      await tryFill(page.getByLabel(/size and depth/i), sanitize(issue.description), "size/depth description");
      await selectDropdown(/major road/i, issue.majorRoad, "major road (required)");
      await selectDropdown(/shoe ?box/i, issue.shoeBoxOrLarger, "shoe box size (required)");
      if (issue.additionalInfo) await tryFill(page.getByLabel(/additional information/i), sanitize(issue.additionalInfo), "additional info");
      if (issue.photos?.length) {
        console.log("   → attaching photo(s)…");
        result.photosAttached = await attachPhotos(issue.photos);
      }
      await reportUnsetDropdowns(); // flag any required dropdown we still don't map
      console.log("   → advancing to Contact…");
      await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
      // If Next didn't advance, a required field didn't commit. Say so NOW instead
      // of waiting out the full handoff in silence (which looked like a hang) — then
      // waitForStep(4) below still gives the human time to fix it and continue.
      if (!(await settle(page.getByRole("heading").filter({ hasText: /Step 4/i }), 5000))) {
        console.log("  ⚠ still on Step 3 after Next — a required field didn't take:");
        await reportUnsetDropdowns();
        banner(
          "ACTION NEEDED (human):\n" +
            "  • A required Request Details field didn't commit (often a Yes/No\n" +
            "    dropdown). Set it in the open browser and click Next.\n" +
            "  The script will resume and fill Contact automatically.",
        );
      }
    }

    // 8. Contact → fill reporter details, then advance
    if (await waitForStep(4, "Contact")) {
      console.log("8. fill contact…");
      const r = issue.reporter ?? {};
      if (issue.anonymous) {
        await setAnonymous(true); // ticking this hides/clears the contact fields
        console.log("   → filing anonymously: skipping contact fields.");
      } else {
        await setAnonymous(false); // make sure the anonymous box is clear
        await probeFirstName();
        // The "First Name" label also matches a hidden "single name" checkbox, so
        // target the input by its stable Salesforce field id first (the instance
        // prefix changes per session; the C311_First_Name__c suffix is stable).
        await robustFill(/first name/i, r.firstName, "first name", page.locator('input[id$="C311_First_Name__c"]'), page.getByPlaceholder(/first name/i), page.locator('input[name="firstName"]'));
        await robustFill(/last name/i, r.lastName, "last name");
        await robustFill(/initial/i, r.initial, "initial");
        // The phone field is labelled "Primary Contact Number", not "phone".
        await robustFill(/primary contact number/i, r.phone, "primary contact number");
        await robustFill(/primary extension number/i, r.extension, "primary extension number");
        await selectDropdown(/primary device type/i, r.deviceType, "primary device type");
        if (r.smsUpdates) await checkChannel("Preferred Notification Channels", "SMS");
        if (r.emailUpdates) await checkChannel("Preferred Notification Channels", "Email");
        // Standalone, always-required "SMS Phone Number" field (distinct from
        // "Primary Contact Number") — fill from smsPhone, falling back to phone.
        await robustFill(/sms phone number/i, r.smsPhone ?? r.phone, "SMS phone number");
        // Email is required once a channel is selected — fill it LAST so the field
        // is in its required state, then blur to commit. input[type=email] first.
        await robustFill(/^\s*email/i, r.email, "email", page.locator('input[type="email"]'));
      }
      console.log("   → advancing to Review…");
      await page.getByRole("button", { name: /^next$/i }).first().click({ timeout: 8000 }).catch(() => {});
      // No post-click sleep: waitForStep(5) below blocks until the Review step heading appears.
    }

    // 9. Stop at Review & Submit — everything is filled; the human solves the
    //    reCAPTCHA and clicks Submit. The script never submits.
    if (await waitForStep(5, "Review")) {
      result.reachedReview = true;
      const photoReminder =
        issue.photos?.length && !result.photosAttached
          ? "\n  • Heads up: your photo(s) weren't auto-attached — add them before submitting."
          : "";
      banner(
        "ALL FIELDS FILLED — over to you (human):\n" +
          "  • Review everything in the open browser.\n" +
          "  • Solve the reCAPTCHA and click Submit yourself." +
          photoReminder +
          "\n  This script will NOT submit. Close the window when done.",
      );
    } else {
      banner(
        "Stopped before Review. A step likely has a required field the script\n" +
          "didn't fill (it won't advance until that's set). Fill it in the browser\n" +
          "and continue, or tell me the field so I can add it.",
      );
    }

    if (!headless) await page.waitForTimeout(HANDOFF_MS);
  } catch (e) {
    result.error = (e as Error).message.split("\n")[0];
    console.log("ERROR:", result.error);
    await page.screenshot({ path: "/tmp/311-prefill-error.png", fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
  return result;
}

// Run as a CLI only when this file is executed directly (e.g. `npm run prefill`
// / `npx tsx prefill-pothole.mts [issue.json]`). When imported by other software
// this block is skipped, so importing never auto-launches a browser.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const issuePath = process.argv[2];
  let issue: PotholeIssue = DEFAULT_ISSUE;
  if (issuePath) {
    // A missing or malformed file should explain itself, not dump a Node stack.
    if (!existsSync(issuePath)) {
      console.error(
        `Issue file not found: ${issuePath}\n` +
          `  • Use the built-in sample instead:      npm run prefill\n` +
          `  • Or create the file (see README "Issue file"), then:  npm run prefill -- ${issuePath}`,
      );
      process.exit(1);
    }
    try {
      issue = { ...DEFAULT_ISSUE, ...JSON.parse(readFileSync(issuePath, "utf8")) };
    } catch (e) {
      console.error(`Couldn't parse ${issuePath} as JSON: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  console.log("issue:", issuePath ? `(from ${issuePath})` : "(built-in sample)");
  await prefillPothole(issue, {
    headless: process.env.HEADLESS === "1",
    handoffMs: Number(process.env.HANDOFF_TIMEOUT_MS ?? 300000),
  });
}
