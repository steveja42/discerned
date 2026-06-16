// Settings overlay opened from the TopBar gear icon. Self-contained: it pulls
// clip/bridge state from useLibraryBridge() (available app-wide via ClipStoreProvider)
// so it works from any page, and hosts the clip import/export actions that used to
// live in the Library footer's sov-strip.

'use client';

import { useState } from 'react';
import { useLibraryBridge } from '@/hooks/useLibraryBridge';
import { exportClipsJson } from '@/lib/export-utils';
import { ImportDialog } from '@/components/clips/ImportDialog';
import { JsonImportDialog } from '@/components/clips/JsonImportDialog';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const { bridgePresent, clips, categories, addClips, addCategories } = useLibraryBridge();
  const [importOpen, setImportOpen] = useState(false);
  const [jsonImportOpen, setJsonImportOpen] = useState(false);

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
      </div>
    </div>
  );
}
