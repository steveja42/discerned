'use client';

import { useRef, useState } from 'react';
import type { ClipData } from '@/lib/types';
import { sendImportClips, sendUpdateCategories } from '@/lib/bridge/extension-bridge';
import { CATEGORIES } from '@/lib/constants';

type Status = 'idle' | 'ready' | 'done' | 'error';

interface ExportFile {
  version?: number;
  clips: ClipData[];
}

interface Props {
  bridgePresent: boolean;
  existingCustomCategories: string[];
  onClose: () => void;
  onClipsImported: (clips: ClipData[]) => void;
  onCategoriesCreated: (cats: string[]) => void;
}

function extractCustomCategories(clips: ClipData[], existing: string[]): string[] {
  const builtinKeys = new Set(Object.keys(CATEGORIES).map((k) => k.toLowerCase()));
  const existingSet = new Set(existing.map((c) => c.toLowerCase()));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const clip of clips) {
    const cat = clip.evaluation?.category?.trim();
    if (!cat) continue;
    const lower = cat.toLowerCase();
    if (!builtinKeys.has(lower) && !existingSet.has(lower) && !seen.has(lower)) {
      seen.add(lower);
      result.push(cat);
    }
  }
  return result;
}

export function JsonImportDialog({ bridgePresent, existingCustomCategories, onClose, onClipsImported, onCategoriesCreated }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [parsedClips, setParsedClips] = useState<ClipData[]>([]);
  const [newCategories, setNewCategories] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as unknown;
        let clips: ClipData[];

        if (Array.isArray(parsed)) {
          clips = parsed as ClipData[];
        } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as ExportFile).clips)) {
          clips = (parsed as ExportFile).clips;
        } else {
          throw new Error('Unrecognised format — expected a Discerned export file.');
        }

        if (clips.length === 0) throw new Error('No clips found in this file.');

        const cats = extractCustomCategories(clips, existingCustomCategories);
        setParsedClips(clips);
        setNewCategories(cats);
        setStatus('ready');
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to parse file.');
        setStatus('error');
      }
    };
    reader.onerror = () => { setErrorMessage('Could not read the file.'); setStatus('error'); };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleImport() {
    onClipsImported(parsedClips);
    if (newCategories.length > 0) onCategoriesCreated(newCategories);
    if (bridgePresent) {
      sendImportClips(parsedClips);
      const allCustom = [...existingCustomCategories, ...newCategories];
      if (allCustom.length > 0) sendUpdateCategories(allCustom);
    }
    setStatus('done');
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Import JSON">
        <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>

        {status === 'idle' && (
          <>
            <h2>Import from JSON</h2>
            <p className="lede">Select a Discerned <strong>.json</strong> export file to restore clips.</p>
            {!bridgePresent && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 12 }}>
                Extension not detected — clips will appear this session but won&apos;t be saved permanently.
              </p>
            )}
            <div className="modal-foot">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
                aria-hidden="true"
                tabIndex={-1}
              />
              <button className="btn primary" onClick={() => fileInputRef.current?.click()}>Choose .json file</button>
              <button className="btn ghost" onClick={onClose} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </>
        )}

        {status === 'ready' && (
          <>
            <h2>Ready to import</h2>
            <p className="lede">
              Found <strong>{parsedClips.length} clip{parsedClips.length !== 1 ? 's' : ''}</strong>
            </p>
            {newCategories.length > 0 && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-3)', marginTop: 8 }}>
                New {newCategories.length === 1 ? 'category' : 'categories'}: {newCategories.join(', ')}
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

        {status === 'done' && (
          <>
            <h2>Import complete</h2>
            <p className="lede">
              <strong>{parsedClips.length} clip{parsedClips.length !== 1 ? 's' : ''}</strong> imported
              {newCategories.length > 0 && <> · {newCategories.length} new {newCategories.length === 1 ? 'category' : 'categories'} created</>}.
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
