---
name: corpus-sweep
description: Run the fortnightly 206-domain capture-quality corpus sweep (discerned-ext) — preflight, background capture, parallel visual review, staged recovery of blocked domains. Use when the user asks to run, start, resume, or recover a corpus sweep, or to review sweep results.
disable-model-invocation: false
---

# Corpus sweep

Drives `scripts/corpus-sweep-run.ps1` from the monorepo root (`c:\dev\discerned`). Full background/details live in `CLAUDE.md` → "Running the fortnightly corpus sweep" — read that section if something here is ambiguous. This skill exists to get the **backup rule** right, since getting it wrong silently destroys the ability to detect a regression.

## The one rule that matters: when to pass `-Backup`

`-Backup` snapshots the current `test-output/corpus-sweep-run/` before it gets overwritten, so the run you're about to start has something to compare against. It is **opt-in**, and getting this wrong has actually destroyed a regression's evidence before (2026-09-15: snapchat-web's cast broke between two runs, but both surviving backups were 37 minutes apart because every failed re-run had rotated the good baseline out — the regression couldn't be demonstrated and had to be filed `regression: "unknown"`).

- **Starting a fresh, real full sweep** (new day/session, previous run's results already reviewed) → pass `-Backup`.
- **Re-running after any kind of failure** (bad flag, burnt IP, failed preflight, Chrome was still open) → **omit `-Backup`**. The existing baseline is still the good one; backing up now would replace it with a copy of the broken run.
- **`-Resume` (recovering blocked/failed domains)** → never pass `-Backup` — the script skips it automatically even if you do, because a run in progress is not a new baseline-worthy state.
- **`-Attended`** (clicking through gates by hand for specific domains) → never backed up; it's a handful of domains, not a full run, and the flag isn't accepted here.

When in doubt, ask whether the previous run in `test-output/corpus-sweep-run/` has already been reviewed and is worth preserving as a comparison point. If yes and this is a genuine new sweep → `-Backup`. If this is just a do-over of something that just broke → no `-Backup`.

## Commands

```powershell
# 1. Full fortnightly sweep — snapshot the previous run first.
pwsh -File scripts/corpus-sweep-run.ps1 -Backup

# 1b. Re-running after an error (bad flag, burnt IP, failed preflight). NO -Backup.
pwsh -File scripts/corpus-sweep-run.ps1

# 2. Hand off to parallel review WHILE it captures (see "Review" below).

# 3. Recovery pass over blocked domains — short, wider-paced, never backed up.
pwsh -File scripts/corpus-sweep-run.ps1 -Resume -Gap 45 -Foreground

# 3b. ATTENDED recovery for gates only a human can clear. Requires -Only.
pwsh -File scripts/corpus-sweep-run.ps1 -Attended -Only discogs,producthunt

# 4. Rebuild the gallery, then diff against the backup step 1 took.
node tests/e2e/tools/sweep-gallery.mjs
node tests/e2e/tools/diff-sweep-run.mjs corpus-sweep-run--backup-<stamp>

# Abort a background sweep without touching the user's dev servers.
pwsh -File scripts/corpus-sweep-run.ps1 -Stop
```

## Preflight (handled automatically, but know the failure modes)

The script checks, and exits early if any fail:
- **Chrome must be fully closed** — the sweep drives the warm `Profile 3`; a live Chrome holds its lock.
- **`discerned-ext/dist-test/` must be current** — rebuilt automatically via `pnpm build:test` when missing, or when any build input (`src/`, `manifest.json`, `vite.config.ts`, `tsconfig.json`, `scripts/build-injected.mjs`) is newer than the last build. It compares source mtimes, not wall-clock age: a day-old build with no source changes is fine, a 20-minute-old one is stale if you edited `capture.ts` after it.
- **The web app must be up on `:3000`** — needed for the clip/cast render steps.

## Review (not scriptable — this is the actual work)

**Review in parallel with capture, not after it.** Capture and review overlap by design: as each domain lands it is sliced into legible bands under `test-output/corpus-sweep-run/slices/` and announced in `test-output/sweep-slices.log`. **The log says which domains need review** — it applies the same staleness rule as `review-queue.mjs`, so you can work straight from it:

```
READY cbc cov=72% [NOT REVIEWED — clip and cast]     <- open these, record a verdict
  clip 1: …/slices/cbc--slice-1.png
  cast 1: …/slices/cbc--castslice-1.png
OK    reuters cov=50% — verdict current               <- sliced, nothing to do
```

Everything gets sliced either way (slices must stay current whether or not anyone opens them), but only `READY` lines carry paths. Raw clip PNGs are ~8000px and downscale ~4x on read, so always review the **slices**, never the full PNG.

A tag is a snapshot from when the domain landed — if Pass-2 re-captures it later, an earlier line is stale text. `review-queue.mjs` stays authoritative for "what's outstanding right now", and is what you use to **resume review in a later session**, since the watcher exits at `DONE`. When starting a background (non-`-Foreground`) run, hand this off explicitly:

> A corpus sweep is running in the background. Tail `test-output/sweep-slices.log` (or use Monitor on it). Each landed domain prints either `READY <domain> [reason]` — needs review, with its slice paths — or `OK <domain> — verdict current`, which you can ignore. For each `READY` domain, read EVERY clip and cast band it lists (up to 3 each — content buried under a video rail or carousel does not reach band 1) and record a verdict via `record-verdict.mjs`. If a band line says some were NOT written and the verdict turns on what is below, re-slice with `--max`. Where comparable against the previous backup, call out real regressions explicitly (`regression:"regressed"` + `regressedFrom`). Keep going until the log prints `DONE`.

**The queue only lists what genuinely needs looking at — trust it.** One rule, applied to the clip and the cast separately:

> a surface needs review if it has **no review stamp**, or if its **image differs from the baseline AND that surface's review predates the capture**.

So a re-sweep producing a byte-identical capture does **not** re-queue it, and a changed cast re-queues only the cast — the row says which (`[CAST changed — clip review still stands]`). The same rule drives the slice log's `READY`/`OK` tags: both read `tests/e2e/tools/lib/review-state.mjs`, so the two can never disagree.

**Pruning happens once per run**, when the queue runs at the end of capture (the watcher invokes it on `DONE`; `-Foreground`/`-Attended` call it inline). It clears only the stale surface's stamp — `verdict`/`severity`/`note`/`where` survive, so when one surface changes you can read the existing note from `visual-findings.json` for what was said about the other. `review-queue.mjs` is the only writer; the watcher is read-only, so it can't race a `record-verdict.mjs` write from the review session. Use `--no-prune` for a read-only pass — always when `--run-dir` points at a backup. After a `-Stop`, run the queue by hand: the watcher was killed before it could.

**Slices can go stale — every path now catches up automatically.** Review reads the sliced bands in `test-output/corpus-sweep-run/slices/`, and a domain re-captured outside the normal slicing path (a Pass-2 retry landing late, the watcher being down) used to keep its OLD bands beside a fresh PNG with nothing marking them. All three paths now run the catch-up at the end — `-Foreground` and `-Attended` inline, and the background run from the watcher's own `DONE` branch, which is the only thing that knows when a detached sweep finished. Run it by hand if you re-capture a domain outside a sweep, or after `-Stop` (which kills the watcher before it can):

```bash
python3 tests/e2e/tools/slice-clip.py --all --stale-only
python3 tests/e2e/tools/slice-clip.py --all --stale-only --cast
```

It only re-cuts domains whose PNG is newer than their bands, so it is cheap to run over the whole corpus.

**`where` and `--reviewed` are different things.** `where` = where the **defect** is; `--reviewed` = which surfaces you **looked at** (default `both`). Re-checking just the cast:

```bash
node tests/e2e/tools/record-verdict.mjs cbc flaw cast "Cast renders hero as alt text." --severity 4 --reviewed cast
```

That stamps the cast and leaves the clip's stamp alone. Don't use `where` to mean coverage — that misreading re-queues every domain whose defect was on one surface.

`prune-stale-findings.mjs` is only needed for a bulk pass against an explicit baseline folder; the queue handles the normal case.

### Recording a verdict

```bash
node tests/e2e/tools/record-verdict.mjs <domain> <clean|flaw|critical|blocked> <clip|cast|both> \
  "<one-sentence note>" --severity <0-10> [--reviewed clip|cast|both]

# many at once — one atomic write, preferred while working through a run
node tests/e2e/tools/record-verdict.mjs --batch-file verdicts.json
```

**`severity` is the number everything sorts and trends on**, so it is required for `flaw`/`critical`, defaults to `0` for `clean`, and is omitted for `blocked` (nothing was captured to rate). It must agree with the verdict — `clean` 0-2, `flaw` 3-7, `critical` 6-10 — and a contradiction is rejected rather than stored, since a "flaw" rated 0 is a typo, not a judgment.

| | |
|---|---|
| **0** | perfect — indistinguishable from the source's content column |
| **1-2** | cosmetic: spacing, a stray glyph, a slightly-off avatar |
| **3-4** | a real but minor loss: one missing byline, a dropped caption, surviving chrome a reader would scroll past |
| **5-6** | a substantive piece wrong or missing — no hero, broken comment thread, mangled stats row — but still recognisably the right content |
| **7-8** | the clip misrepresents the page: wrong block captured, most of the body absent, layout collapsed |
| **9-10** | unusable: empty, or entirely the wrong content (a video rail, another post) |

**The verdict judges the capture pipeline, not the site's access posture.** A login wall, a paywall, or a "sign in to continue" gate is something the SITE decided to show — if that's genuinely what the loaded page contained and the extension faithfully captured it (title, whatever preview text was actually rendered, the gate itself), that's a **clean, low-severity** capture: the pipeline did its job on the content that was available. Don't rate it down for the site withholding content our code never had a chance to see. This mirrors `hidden-prose-probe`'s paywall/finder-mis-pick distinction above — same principle, applied to verdict severity instead of a probe's diagnosis.

The distinction that DOES matter: **did the pipeline lose or mangle what WAS on the loaded page?** A wrong block captured, a collapsed layout, a missing byline that was actually present in the DOM — that's a real defect regardless of how little content the site allowed through. So `blocked` (nothing captured — a 403, a hard Cloudflare deny, a truly empty page) is its own verdict with no severity; a faithfully-captured gate is `clean`; and only a pipeline defect on the content that DID load earns `flaw`/`critical`.

Rate what you **see** in the image, not what you infer about the cause, and rate the **worst** of clip/cast — `where` already records which surface. Keep notes to one sentence stating the flaw; no dates, no fix history.

Set `regression: "regressed"` (plus a `regressedFrom` "was X, now Y") only when you have actually compared against the previous backup's image. It defaults to `"unknown"`, which is honest — never `"none"`, which would assert a comparison nobody made.

## Pacing and IP reputation (why not to just retry blocked domains back-to-back)

- Every observable wait is jittered by default — don't set `SWEEP_NO_JITTER=1` for a real run.
- Cap defended (Cloudflare/PerimeterX) domains at 3-5 per session; retrying the walled set back-to-back has previously degraded the exit IP until even Google served a captcha. Treat a Google captcha mid-session as a hard stop — don't record `blocked` verdicts from after that point.
- A walled domain often just needs `cf_clearance` banked by hand: open it in the warm profile, clear the challenge, close Chrome, then re-run — the cookie carries over.
- Diagnose a gate with bare `curl -sI -A '<real UA>' <url>` before blaming the harness — separates "this site walls us" from "our IP is burned."

## Sweep-triage probes

If a sweep finding needs a mechanism, not just a verdict, reach for one of these before guessing (all opt-in, write to `test-output/`):

| Probe | Answers |
|---|---|
| `DIAG=1 --project=finder-diag-probe` | Which content block the finder picked and why; headline-vs-root relationship |
| `HIDDEN=1 --project=hidden-prose-probe` | Paywall (hidden prose) vs finder mis-pick (visible prose, wrong block) |
| `CLIPW=1 CLIPW_DOMAIN=<d> CLIPW_WIDTH=610 --project=clip-width-probe` | Why a clip renders in narrow collapsed columns |
| `PREWS=1 PREWS_URL=<url> --project=pre-ws-probe` | Why a code block lost or gained whitespace |
| `FLAKY=1 FLAKY_URL=<url> --project=flaky-capture-probe` | Is a domain's capture actually flaky, or deterministically broken |

Full details, env vars, and gotchas for each — plus what each has actually found (domain rebrands, changed article-ID schemes, an empty-shell hub URL mistaken for a paywall) — are in `docs/corpus-sweep-history.md` → "Sweep-triage probes".
