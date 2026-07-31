import type { Metadata } from 'next';
import Link from 'next/link';

// A static legal document: no auth, no TopBar, no client hooks. Deliberately a
// server component so it renders as plain HTML in the static export — the Chrome
// Web Store reviewer must be able to read it with no JavaScript.

// Last substantive revision. Shown to users and linked from the Chrome Web Store
// listing — bump it whenever the data-handling description below changes.
const LAST_UPDATED = '30 July 2026';

export const metadata: Metadata = {
  title: 'Privacy Policy · Discerned',
  description:
    'How the Discerned browser extension and website handle your data: local-first storage, no accounts, no server, no tracking in the extension.',
};

const prose: React.CSSProperties = { margin: '0 0 16px' };
const list: React.CSSProperties = { ...prose, paddingLeft: 22 };
const item: React.CSSProperties = { marginBottom: 8 };
const h2: React.CSSProperties = {
  fontFamily: 'var(--serif)',
  fontSize: 26,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: '40px 0 14px',
  letterSpacing: '-0.015em',
};
const h3: React.CSSProperties = {
  fontFamily: 'var(--serif)',
  fontSize: 19,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: '28px 0 10px',
};

export default function PrivacyPage() {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--paper)' }}>
      <section
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: '56px 32px 80px',
          fontFamily: 'var(--serif)',
          color: 'var(--ink-2)',
          fontSize: 17,
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 24px', fontSize: 15 }}>
          <Link href="/">← Discerned</Link>
        </p>
        <h1
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 34,
            fontWeight: 500,
            color: 'var(--ink)',
            margin: '0 0 8px',
            letterSpacing: '-0.02em',
          }}
        >
          Privacy Policy
        </h1>
        <p style={{ ...prose, fontSize: 15 }}>
          Last updated {LAST_UPDATED}. Covers the Discerned browser extension and the Discerned
          website at discerned.online. The two are described separately below, because they do
          not handle data the same way.
        </p>

        <h2 style={h2}>The short version</h2>
        <p style={prose}>
          Discerned has <strong>no accounts and no server that stores your data</strong>. Everything
          you capture stays in your own browser until <em>you</em> choose to publish it, and when
          you do, it goes directly from your browser to the Nostr relays you have configured —
          never through us.
        </p>
        <p style={prose}>
          We cannot see what you browse, what you clip, or what you rate. That is not a promise
          about how we handle your data; it is a consequence of the architecture. There is nowhere
          for that data to arrive.
        </p>
        <p style={prose}>
          The website does use a privacy-preserving visitor counter, described in{' '}
          <em>The website</em> below. <strong>The extension contains no analytics or tracking of
          any kind.</strong>
        </p>

        <h2 style={h2}>The extension</h2>

        <h3 style={h3}>What it stores, and where</h3>
        <p style={prose}>
          All of the following is stored <strong>locally on your device</strong>, in the browser&apos;s
          own extension storage and IndexedDB. None of it is transmitted to Discerned.
        </p>
        <p style={prose}>
          <strong>Clips.</strong> When you capture a page, selection, or article, the extension
          stores the captured text and HTML, the page title and URL, any images inlined into the
          capture, and the evaluation you attach to it (Signal rating, Qualifier tags, Category,
          and any note).
        </p>
        <p style={prose}>
          <strong>Clips are stored unencrypted</strong> as structured data in your local browser
          profile. Encryption at rest is planned but not yet implemented. Anyone with access to
          your computer and browser profile can read them, and they are included in a
          browser-profile backup or sync if you have one configured. Please take this into account
          before clipping sensitive material.
        </p>
        <p style={prose}>
          <strong>Settings and cached profile data.</strong> Your relay list, theme, and other
          preferences are stored locally. When you sign in, the extension fetches your public Nostr
          profile and relay list from relays and caches them so it need not re-fetch on every use.
        </p>

        <h3 style={h3}>Identity and keys</h3>
        <p style={prose}>
          Discerned supports three sign-in modes, and key handling differs in each:
        </p>
        <ul style={list}>
          <li style={item}>
            <strong>NIP-07 (browser signing extension)</strong> — your private key never enters
            Discerned at all. It stays in your signing extension, which we ask to sign each event.
          </li>
          <li style={item}>
            <strong>NIP-46 (remote signer)</strong> — your private key stays with your remote
            signer. Discerned stores only an ephemeral client keypair used to talk to it.
          </li>
          <li style={item}>
            <strong>Imported private key (nsec)</strong> — the key is encrypted with a PIN you
            choose, using the NIP-49 standard, and only the encrypted blob is written to local
            storage. The unencrypted key exists in memory only, for as long as it takes to sign.
          </li>
        </ul>
        <p style={prose}>
          In every mode, your private key is never transmitted to Discerned or any third party. We
          could not recover it for you if you lost it.
        </p>

        <h3 style={h3}>What leaves your browser</h3>
        <p style={prose}>Only three kinds of network traffic originate from the extension:</p>
        <ul style={list}>
          <li style={item}>
            <strong>Casts you publish.</strong> When you explicitly choose to cast, the signed
            Nostr event is sent from your browser to the relays in your relay list. This is a
            deliberate, public act: a cast is published to a public network, is not encrypted, is
            readable by anyone, and <strong>cannot reliably be deleted</strong> once relays have
            it. Clips you do not cast are never transmitted.
          </li>
          <li style={item}>
            <strong>Images and media within a capture.</strong> To make a clip readable offline,
            the extension fetches the images on the page you are capturing and embeds them in the
            clip. These requests go directly to the sites hosting those images — the same servers
            your browser already contacted to render the page.
          </li>
          <li style={item}>
            <strong>Reading from relays.</strong> To display the feed and resolve profiles, the
            extension reads events from your configured relays.
          </li>
        </ul>
        <p style={prose}>
          Relay operators are independent third parties, not Discerned. A relay you connect to can
          see your IP address and the events you publish or request, as any server you connect to
          can. Choose relays you trust; you can edit the list at any time in Settings.
        </p>

        <h3 style={h3}>Why the extension asks for broad site access</h3>
        <p style={prose}>
          On installation, Chrome warns that Discerned can &ldquo;read and change all your data on
          all websites.&rdquo; That warning follows from one design requirement: a web clipper must
          work on whatever page you are reading, and we cannot know in advance which pages those
          will be.
        </p>
        <p style={prose}>
          In practice the extension reads page content <strong>only when you actively invoke
          it</strong>, via the toolbar button or the context menu. It does not monitor pages in the
          background, does not build a browsing history, and does not send page data anywhere. We
          request no permission that would let us do so, and the extension is open source, so this
          is verifiable rather than merely asserted.
        </p>

        <h2 style={h2}>The website</h2>
        <p style={prose}>
          discerned.online is a static site hosted by Netlify, which keeps standard server access
          logs (including IP addresses) as an ordinary part of serving a website. The site sets no
          advertising cookies and runs no advertising scripts.
        </p>
        <p style={prose}>
          <strong>Visitor counting.</strong> The site uses{' '}
          <a href="https://www.goatcounter.com/" target="_blank" rel="noopener noreferrer">
            GoatCounter
          </a>
          , an open-source, privacy-focused analytics tool, to count page views and extension
          downloads. It is <strong>cookieless</strong>, collects no personal data, does not
          fingerprint visitors, and does not track you across other websites. It records the page
          path, referring page, and coarse browser and country information — never an identity, and
          never anything tied to your Nostr keys or your clips. It runs on the production website
          only; it is <strong>not part of the extension</strong>, and it never sees your clips or
          browsing outside discerned.online.
        </p>
        <p style={prose}>
          <strong>Feedback form.</strong> If you submit the{' '}
          <Link href="/feedback">feedback form</Link>, the message you write is filed as a{' '}
          <strong>public GitHub issue</strong>. Do not include anything you would not want
          published. The form is protected by Cloudflare Turnstile, an anti-abuse check that
          receives your IP address; Cloudflare and GitHub each handle that data under their own
          privacy policies. The form deliberately does not attach your identity, sign-in mode, or
          clip data.
        </p>

        <h2 style={h2}>Children</h2>
        <p style={prose}>
          Discerned is not directed at children under 13, and we do not knowingly collect data from
          them. As we collect no personal data from anyone, this is largely academic — but worth
          stating plainly.
        </p>

        <h2 style={h2}>Deleting your data</h2>
        <p style={prose}>
          Clips and settings can be deleted from within the app, and removing the extension deletes
          its local storage entirely. There is no account to close and nothing for us to delete on
          your behalf, because we hold nothing.
        </p>
        <p style={prose}>
          Casts are the exception, and the important one to understand. Once published, a cast has
          been distributed to independent relay operators. You can request deletion (a NIP-09
          request), but relays are not obliged to honour it and copies may persist indefinitely.
          <strong> Treat casting as permanent and public.</strong>
        </p>

        <h2 style={h2}>Changes to this policy</h2>
        <p style={prose}>
          If this policy changes materially, we will update the date at the top and note the change
          in the extension&apos;s release notes. The revision history is public in the project&apos;s
          git repository.
        </p>

        <h2 style={h2}>Contact</h2>
        <p style={prose}>
          Questions or concerns: open an issue via the{' '}
          <Link href="/feedback">feedback page</Link> (public), or email{' '}
          <a href="mailto:steveja007@gmail.com">steveja007@gmail.com</a> (private).
        </p>
      </section>

    </div>
  );
}
