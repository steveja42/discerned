'use client';

import { useRef, useState } from 'react';
import type { ClipData } from '@/lib/types';
import { parseEnex } from '@/lib/enex-parser';
import { sendImportClips, sendUpdateCategories } from '@/lib/bridge/extension-bridge';
import { CATEGORIES } from '@/lib/constants';

type Status = 'idle' | 'parsing' | 'ready' | 'importing' | 'done' | 'error';

interface Props {
  bridgePresent: boolean;
  existingCustomCategories: string[];
  onClose: () => void;
  onClipsImported: (clips: ClipData[]) => void;
  onCategoriesCreated: (cats: string[]) => void;
}

function isNewCategory(name: string, customCats: string[]): boolean {
  const lower = name.toLowerCase();
  if (Object.keys(CATEGORIES).some((k) => k.toLowerCase() === lower)) return false;
  if (customCats.some((c) => c.toLowerCase() === lower)) return false;
  return true;
}

export function ImportDialog({ bridgePresent, existingCustomCategories, onClose, onClipsImported, onCategoriesCreated }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [parsedClips, setParsedClips] = useState<ClipData[]>([]);
  const [notebookName, setNotebookName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const derived = file.name.replace(/\.enex$/i, '');
    setNotebookName(derived);
    setStatus('parsing');

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result as string;
        const clips = parseEnex(text, derived);
        setParsedClips(clips);
        setStatus('ready');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to parse file.');
        setStatus('error');
      }
    };
    reader.onerror = () => {
      setErrorMessage('Could not read the file.');
      setStatus('error');
    };
    reader.readAsText(file);

    // Reset so the same file can be re-selected after an error
    e.target.value = '';
  }

  function handleImport() {
    setStatus('importing');

    // Instant UI feedback — clips appear immediately in the library
    onClipsImported(parsedClips);

    const newCat = isNewCategory(notebookName, existingCustomCategories) ? notebookName : null;
    if (newCat) onCategoriesCreated([newCat]);

    if (bridgePresent) {
      sendImportClips(parsedClips);
      const allCustom = newCat ? [...existingCustomCategories, newCat] : existingCustomCategories;
      if (allCustom.length > 0) sendUpdateCategories(allCustom);
    }

    setStatus('done');
  }

  const newCat = status === 'ready' && isNewCategory(notebookName, existingCustomCategories) ? notebookName : null;

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Import Evernote notes">
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>

        {status === 'idle' && (
          <>
            <h2>Import from Evernote</h2>
            <p className="lede">Select an <strong>.enex</strong> file exported from Evernote. Notes will be imported as clips using the filename as their category.</p>
            {!bridgePresent && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 12 }}>
                Extension not detected — clips will appear this session but won&apos;t be saved permanently.
              </p>
            )}
            <div className="modal-foot">
              <input
                ref={fileInputRef}
                type="file"
                accept=".enex"
                onChange={handleFileChange}
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button className="btn primary" onClick={() => fileInputRef.current?.click()}>
                Choose .enex file
              </button>
              <button className="btn ghost" onClick={onClose} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </>
        )}

        {status === 'parsing' && (
          <>
            <h2>Reading file…</h2>
            <p className="lede">Parsing notes from <em>{notebookName}</em></p>
          </>
        )}

        {status === 'ready' && (
          <>
            <h2>Ready to import</h2>
            <p className="lede">
              Found <strong>{parsedClips.length} note{parsedClips.length !== 1 ? 's' : ''}</strong> from <em>{notebookName}</em>
            </p>
            {newCat && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>
                New category &ldquo;{newCat}&rdquo; will be created.
              </p>
            )}
            {!bridgePresent && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>
                Extension not detected — clips will appear this session but won&apos;t be saved permanently.
              </p>
            )}
            <div className="modal-foot">
              <button className="btn primary" onClick={handleImport}>
                Import {parsedClips.length} clip{parsedClips.length !== 1 ? 's' : ''}
              </button>
              <button className="btn ghost" onClick={onClose} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </>
        )}

        {status === 'importing' && (
          <>
            <h2>Importing…</h2>
            <p className="lede">Adding {parsedClips.length} clips to your library.</p>
          </>
        )}

        {status === 'done' && (
          <>
            <h2>Import complete</h2>
            <p className="lede">
              <strong>{parsedClips.length} clip{parsedClips.length !== 1 ? 's' : ''}</strong> imported
              {newCat && <> · Category <em>{newCat}</em> created</>}.
            </p>
            {!bridgePresent && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>
                Extension not detected — clips will not persist after this session.
              </p>
            )}
            <div className="modal-foot">
              <button className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <h2>Import failed</h2>
            <p className="lede" style={{ color: 'oklch(0.45 0.18 25)' }}>{errorMessage}</p>
            <div className="modal-foot">
              <button className="btn primary" onClick={() => { setStatus('idle'); setErrorMessage(''); }}>Try again</button>
              <button className="btn ghost" onClick={onClose} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
