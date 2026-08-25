// Settings overlay opened from the TopBar gear icon. Self-contained: it pulls
// clip/bridge state from useLibraryBridge() (available app-wide via ClipStoreProvider)
// so it works from any page, and hosts the clip import/export actions that used to
// live in the Library footer's sov-strip.

'use client';

import { useEffect, useState } from 'react';
import { useLibraryBridge } from '@/hooks/useLibraryBridge';
import { exportClipsJson } from '@/lib/export-utils';
import { ImportDialog } from '@/components/clips/ImportDialog';
import { JsonImportDialog } from '@/components/clips/JsonImportDialog';
import {
  applyRelayMode, applyRelayList, getCurrentRelayMode, getRelayRows,
  normaliseRelayUrl, DEFAULT_RELAYS,
  type RelayMode, type RelayRow,
} from '@/lib/constants';
import {
  sendRelayModeToExtension, sendRelayListToExtension, subscribeBridge,
} from '@/lib/bridge/extension-bridge';

// Dev-only: the relay toggle is hidden in production. NEXT_PUBLIC_LOCAL_RELAY is
// set in .env.local for dev/test and unset in production, so it doubles as a
// "this is a dev build" signal alongside NODE_ENV.
const RELAY_TOGGLE_VISIBLE =
  process.env.NODE_ENV !== 'production' || !!process.env.NEXT_PUBLIC_LOCAL_RELAY;

interface SettingsModalProps {
  onClose: () => void;
}

const RELAY_SOURCE_LABEL: Record<RelayRow['source'], string> = {
  default: 'Default',
  user: 'Added by you',
  discovered: 'From your Nostr profile',
};

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { bridgePresent, clips, categories, addClips, addCategories } = useLibraryBridge();
  const [importOpen, setImportOpen] = useState(false);
  const [jsonImportOpen, setJsonImportOpen] = useState(false);
  const [relayMode, setRelayMode] = useState<RelayMode>(() => getCurrentRelayMode());

  // Relay rows. Seeded from the current list, or the built-in defaults when the
  // extension hasn't pushed one yet (a first-run web-only visitor).
  const [relays, setRelays] = useState<RelayRow[]>(() => {
    const rows = getRelayRows();
    return rows.length > 0
      ? rows
      : DEFAULT_RELAYS.map((url) => ({ url, source: 'default' as const }));
  });
  const [relayInput, setRelayInput] = useState('');
  const [relayError, setRelayError] = useState<string | null>(null);

  // Note both useState calls above read getCurrentRelayMode() / getRelayRows()
  // in their initialisers. That is what picks up an extension bridge push that
  // landed BEFORE this modal mounted (the usual case — it opens on a click, long
  // after hydration), so no mount effect is needed to re-read them; the
  // subscription below covers pushes that arrive while it is open.

  // Adopt pushes from the extension — relays discovered at sign-in arrive this
  // way, so the list updates live without a reload. The mode is mirrored too:
  // the extension is source of truth for it, and it gates whether the list is
  // editable at all.
  useEffect(() => subscribeBridge((msg) => {
    if (msg.type === 'DISCERNED_BRIDGE_RELAY_LIST' && msg.rows.length > 0) {
      setRelays(msg.rows);
    }
    if (msg.type === 'DISCERNED_BRIDGE_RELAYS') {
      setRelayMode(msg.mode);
    }
  }), []);

  // In local relay mode the effective set is exactly [LOCAL_RELAY] — the user's
  // own relays are deliberately ignored so dev/test casts never reach the public
  // network. Editing is therefore disabled: the rows shown aren't the real list,
  // and committing them would record every production default as "removed".
  const relayEditable = relayMode !== 'local';

  // Persist a new row set: recompute the (userRelays, removedRelays) pair the
  // extension stores, hand it over, and apply locally so the feed re-subscribes
  // immediately rather than waiting for the extension's echo.
  const commitRelays = (rows: RelayRow[]) => {
    if (!relayEditable) return;
    setRelays(rows);
    const kept = new Set(rows.map((r) => r.url));
    const userRelays = rows.filter((r) => r.source !== 'default').map((r) => r.url);
    const removedRelays = DEFAULT_RELAYS.filter((url) => !kept.has(url));
    sendRelayListToExtension(userRelays, [...removedRelays]);
    applyRelayList(rows);
  };

  const removeRelay = (url: string) => {
    if (relays.length <= 1) return; // never leave the user with nowhere to publish
    commitRelays(relays.filter((r) => r.url !== url));
  };

  const addRelay = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normaliseRelayUrl(relayInput);
    if (!url) {
      setRelayError('Enter a relay URL like wss://relay.example.com');
      return;
    }
    if (relays.some((r) => r.url === url)) {
      setRelayError('That relay is already in your list.');
      return;
    }
    // A re-added built-in keeps its 'default' source so it drops back out of
    // removedRelays rather than being stored as a user relay.
    const source: RelayRow['source'] =
      (DEFAULT_RELAYS as readonly string[]).includes(url) ? 'default' : 'user';
    commitRelays([...relays, { url, source }]);
    setRelayInput('');
    setRelayError(null);
  };

  const toggleRelayMode = () => {
    const next: RelayMode = relayMode === 'local' ? 'production' : 'local';
    setRelayMode(next);
    applyRelayMode(next);            // local override + re-subscribe immediately
    sendRelayModeToExtension(next);  // make the extension (source of truth) persist + re-broadcast
  };

  // When an import dialog is open, hide the settings modal behind it rather than
  // stacking two backdrops. Closing the dialog returns to the settings modal.
  if (importOpen) {
    return (
      <ImportDialog
        bridgePresent={bridgePresent}
        existingCustomCategories={categories}
        onClose={() => setImportOpen(false)}
        onClipsImported={addClips}
        onCategoriesCreated={addCategories}
      />
    );
  }

  if (jsonImportOpen) {
    return (
      <JsonImportDialog
        bridgePresent={bridgePresent}
        existingCustomCategories={categories}
        onClose={() => setJsonImportOpen(false)}
        onClipsImported={addClips}
        onCategoriesCreated={addCategories}
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <h2>Settings</h2>

        <div className="settings-section">
          <div className="settings-section-label">Clips</div>
          <button className="settings-action" onClick={() => setImportOpen(true)}>
            <span className="label">Import Evernote</span>
            <span className="sub">.enex notebook</span>
          </button>
          <button className="settings-action" onClick={() => setJsonImportOpen(true)}>
            <span className="label">Import JSON</span>
            <span className="sub">Discerned export</span>
          </button>
          <button
            className="settings-action"
            onClick={() => exportClipsJson(clips)}
            disabled={clips.length === 0}
          >
            <span className="label">Export JSON</span>
            <span className="sub">{clips.length} clip{clips.length === 1 ? '' : 's'}</span>
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-section-label">Relays</div>
          <p className="settings-hint">
            Where your public Discerns are published. Relays listed in your Nostr profile
            (NIP-65) are added automatically when you sign in.
          </p>

          <ul className="relay-list">
            {relays.map((relay) => (
              <li key={relay.url} className="relay-row">
                <span className="relay-url" title={relay.url}>{relay.url}</span>
                <span className="relay-badge">{RELAY_SOURCE_LABEL[relay.source]}</span>
                <button
                  className="relay-remove"
                  onClick={() => removeRelay(relay.url)}
                  disabled={!relayEditable || relays.length <= 1}
                  aria-label={`Remove ${relay.url}`}
                  title={relays.length <= 1 ? 'You need at least one relay' : `Remove ${relay.url}`}
                >
                  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>

          <form className="relay-add" onSubmit={addRelay}>
            <input
              type="text"
              value={relayInput}
              onChange={(e) => { setRelayInput(e.target.value); setRelayError(null); }}
              placeholder="wss://relay.example.com"
              aria-label="Relay URL"
              spellCheck={false}
              disabled={!relayEditable}
            />
            <button type="submit" disabled={!relayEditable || !relayInput.trim()}>Add</button>
          </form>
          {relayError && <p className="relay-error" role="alert">{relayError}</p>}

          {!relayEditable && (
            <p className="settings-hint">
              Local relay mode is on, so everything publishes to the local relay only.
              Turn it off to edit your relay list.
            </p>
          )}

          {!bridgePresent && (
            <p className="settings-hint">
              The extension isn&apos;t connected, so this list applies to this site only.
              Install it to publish to these relays.
            </p>
          )}
        </div>

        {RELAY_TOGGLE_VISIBLE && (
          <div className="settings-section">
            <div className="settings-section-label">Developer</div>
            <button className="settings-action" onClick={toggleRelayMode}>
              <span className="label">Use local relay</span>
              <span className="sub">{relayMode === 'local' ? 'ON · ws://localhost:7777' : 'OFF · public relays'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
