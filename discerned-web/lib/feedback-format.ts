// Pure helpers for the feedback pipeline — validation, GitHub issue formatting, and
// the markdown neutering that keeps a submission from acting on the repo. Deliberately
// dependency-free and side-effect-free so BOTH the browser (lib/support.ts) and the
// Netlify function (netlify/functions/feedback.mts) can import them, and so the
// interesting logic is unit-testable without a running function.
//
// See discerned-web/CLAUDE.md → Feedback function.

export const FEEDBACK_TYPES = ['bug', 'idea', 'other'] as const;
export const FEEDBACK_TARGETS = ['extension', 'web', 'both'] as const;

export type FeedbackType = typeof FEEDBACK_TYPES[number];
export type FeedbackTarget = typeof FEEDBACK_TARGETS[number];

export const MESSAGE_MIN = 10;
export const MESSAGE_MAX = 4000;
export const CONTACT_MAX = 200;
export const UA_MAX = 300;
/** Matches a plausible semver-ish extension version; anything else is dropped rather than echoed. */
export const EXT_VERSION_RE = /^[\w.-]{1,20}$/;

/** What the browser POSTs to /api/feedback. */
export interface FeedbackPayload {
  type: FeedbackType;
  target: FeedbackTarget;
  message: string;
  contact?: string;
  /** Honeypot — always "" for a real user. See validatePayload. */
  website?: string;
  /** Cloudflare Turnstile token. Verified server-side; never trusted from the client alone. */
  turnstileToken?: string;
  extVersion?: string;
  ua?: string;
}

export type ValidationResult =
  | { ok: true; value: Required<Pick<FeedbackPayload, 'type' | 'target' | 'message'>> & {
      contact: string; extVersion: string; ua: string;
    } }
  | { ok: false; error: string; /** Honeypot tripped: caller should return a fake success. */ silent?: boolean };

const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * Validate and normalise an untrusted request body.
 *
 * Order matters: the honeypot is checked before anything else so a bot never learns
 * which field tripped it (the caller returns a fake 200 for `silent`), and the cheap
 * structural checks run before the expensive Turnstile round-trip the caller does after.
 */
export function validatePayload(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed request.' };
  }
  const b = body as Record<string, unknown>;

  // Honeypot: a hidden offscreen field no human ever fills. Report failure SILENTLY —
  // a 400 here would teach the bot the field name is a trap and it would strip it next time.
  if (isString(b.website) && b.website.trim() !== '') {
    return { ok: false, error: 'Rejected.', silent: true };
  }

  if (!isString(b.type) || !(FEEDBACK_TYPES as readonly string[]).includes(b.type)) {
    return { ok: false, error: 'Pick what kind of feedback this is.' };
  }
  if (!isString(b.target) || !(FEEDBACK_TARGETS as readonly string[]).includes(b.target)) {
    return { ok: false, error: 'Pick what this is about.' };
  }

  const message = isString(b.message) ? b.message.trim() : '';
  if (message.length < MESSAGE_MIN) {
    return { ok: false, error: `Please write at least ${MESSAGE_MIN} characters.` };
  }
  if (message.length > MESSAGE_MAX) {
    return { ok: false, error: `Please keep it under ${MESSAGE_MAX} characters.` };
  }
  if (looksLikeSpam(message)) {
    return { ok: false, error: 'That looks like spam. If it isn’t, try rephrasing.' };
  }

  const contact = isString(b.contact) ? b.contact.trim() : '';
  if (contact.length > CONTACT_MAX) {
    return { ok: false, error: 'That contact address is too long.' };
  }

  // Version and UA are diagnostics, not user intent: drop/truncate silently rather than
  // failing a legitimate report over a field the user never typed.
  const extVersion = isString(b.extVersion) && EXT_VERSION_RE.test(b.extVersion) ? b.extVersion : '';
  const ua = isString(b.ua) ? b.ua.slice(0, UA_MAX) : '';

  return { ok: true, value: { type: b.type as FeedbackType, target: b.target as FeedbackTarget, message, contact, extVersion, ua } };
}

/**
 * Cheap content heuristics that catch the bulk of what gets past a honeypot.
 * Deliberately conservative — a false positive silences a real user, which is worse
 * than letting one spam issue through for a human to close.
 */
export function looksLikeSpam(message: string): boolean {
  const urls = message.match(/https?:\/\//gi);
  if (urls && urls.length >= 4) return true;
  // A long unbroken blob with no whitespace is never prose.
  if (message.length > 200 && !/\s/.test(message)) return true;
  return false;
}

/**
 * Neutralise the two markdown constructs that let a submission ACT on the repo rather
 * than just describe something. Both insert a zero-width space, which is invisible when
 * rendered but breaks GitHub's parsing:
 *
 *  - `@name` would mass-ping GitHub users when the issue is created.
 *  - `#123` combined with a closing keyword ("fixes #7") would CLOSE unrelated issues.
 *
 * Everything else is left alone: the maintainer wants to read the reporter's formatting,
 * and GitHub already sanitises rendered HTML.
 */
export function neutralizeMarkdown(message: string): string {
  return message
    // The (^|[^\w]) guard is load-bearing: without it an ordinary email address like
    // a@b.com gets mangled into a@​b.com. Only a bare, non-word-prefixed @name pings.
    .replace(/(^|[^\w])@([a-zA-Z0-9][\w-]*)/g, '$1@​$2')
    .replace(/(^|[^\w&])#(\d+)/g, '$1#​$2');
}

/**
 * Derive the issue title from the message's first line — users write bad titles, so the
 * form doesn't ask for one. Collapses whitespace and truncates on a word boundary where
 * possible so the title doesn't end mid-word.
 */
export function deriveIssueTitle(type: FeedbackType, message: string): string {
  const firstLine = message.split('\n').find((l) => l.trim() !== '') ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  const MAX = 70;
  let head = collapsed;
  if (collapsed.length > MAX) {
    const cut = collapsed.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(' ');
    head = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }
  return `[${type}] ${head || 'Feedback'}`;
}

/**
 * Maps our form vocabulary onto GitHub's. `idea` → `enhancement` because that's a GitHub
 * DEFAULT label: it already exists on every repo, it's what anyone browsing the issue list
 * expects, and it's one fewer label to hand-create. The form keeps saying "idea" — that
 * reads better in the UI and the deep-link URL than "enhancement".
 */
const GITHUB_TYPE_LABEL: Record<FeedbackType, string> = {
  bug: 'bug',                 // also a GitHub default
  idea: 'enhancement',        // GitHub default
  other: 'other',
};

/**
 * Labels for the created issue.
 *
 * NOTE: every one of these must ALREADY EXIST on the repo — the GitHub API rejects the
 * whole request with 422 if any label is unknown. `bug` and `enhancement` ship with every
 * repo; the ones to create by hand are: feedback, other, area:extension, area:web, area:both.
 */
export function deriveIssueLabels(type: FeedbackType, target: FeedbackTarget): string[] {
  return ['feedback', GITHUB_TYPE_LABEL[type], `area:${target}`];
}

const TARGET_LABEL: Record<FeedbackTarget, string> = {
  extension: 'Extension',
  web: 'Web app',
  both: 'Both',
};

/**
 * Build the issue body: the user's message (neutered) followed by a diagnostics table.
 * Rows with no value are omitted rather than printed as "n/a".
 */
export function buildIssueBody(input: {
  type: FeedbackType;
  target: FeedbackTarget;
  message: string;
  contact?: string;
  extVersion?: string;
  ua?: string;
  receivedAt?: Date;
}): string {
  const rows: [string, string][] = [
    ['Type', input.type],
    ['Area', TARGET_LABEL[input.target]],
  ];
  if (input.extVersion) rows.push(['Extension version', `\`${input.extVersion}\``]);
  if (input.contact) rows.push(['Contact', neutralizeMarkdown(input.contact)]);
  if (input.ua) rows.push(['User agent', `\`${input.ua.replace(/`/g, '')}\``]);
  rows.push(['Received', (input.receivedAt ?? new Date()).toISOString()]);

  const table = ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');

  return [
    neutralizeMarkdown(input.message),
    '',
    '---',
    '<!-- submitted via discerned.online/feedback -->',
    table,
  ].join('\n');
}
