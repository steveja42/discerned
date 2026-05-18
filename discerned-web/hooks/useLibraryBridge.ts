// Connects the /library page to the Discerned extension bridge.
// Reads and writes clip state via ClipStoreContext so clips persist across
// navigation without being re-fetched from the extension on every mount.

'use client';

import { useEffect, useRef, useState } from 'react';
import { useClipStore } from '@/lib/bridge/ClipStoreContext';
import { listenForBridge } from '@/lib/bridge/extension-bridge';

export function useLibraryBridge() {
  const store = useClipStore();
  const { clips, bridgePresent, pubkey, authMethod, timedOut, categories,
          setClips, prependClip, addClips, setCategories, addCategories, removeCategory,
          setBridgePresent, setTimedOut,
          removeClips, updateClipNote } = store;

  // Clip ID requested by the extension (e.g. "View in Library" after clipping).
  // Library consumes this once via useEffect to set selectedId.
  const [focusClipId, setFocusClipId] = useState<string | null>(null);

  // Capture clip count at mount time so listenForBridge sends the right count
  // in DISCERNED_WEB_READY even though the effect dep array is empty.
  const mountClipCount = useRef(clips.length);

  useEffect(() => {
    const cleanup = listenForBridge((msg) => {
      if (msg.type === 'DISCERNED_BRIDGE_HELLO') {
        setBridgePresent(msg.pubkey, msg.authMethod);
      }
      if (msg.type === 'DISCERNED_BRIDGE_CLIPS') {
        setClips(msg.clips);
      }
      if (msg.type === 'DISCERNED_BRIDGE_NEW_CLIP') {
        prependClip(msg.clip);
      }
      if (msg.type === 'DISCERNED_BRIDGE_FOCUS_CLIP') {
        setFocusClipId(msg.clipId);
      }
      if (msg.type === 'DISCERNED_BRIDGE_CATEGORIES') {
        // Bridge sends the authoritative full list — replace, don't merge.
        setCategories(msg.categories);
      }
    }, mountClipCount.current);

    const timer = setTimeout(setTimedOut, 2000);

    return () => {
      cleanup();
      clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    bridgePresent, pubkey, authMethod, clips, timedOut, categories,
    removeClips, updateClipNote, addClips, addCategories, removeCategory,
    focusClipId, clearFocusClipId: () => setFocusClipId(null),
  };
}
