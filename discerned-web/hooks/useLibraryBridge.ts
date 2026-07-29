// Connects the /clips page to the Discerned extension bridge.
// Reads and writes clip state via ClipStoreContext so clips persist across
// navigation without being re-fetched from the extension on every mount.

'use client';

import { useEffect, useRef, useState } from 'react';
import { useClipStore } from '@/lib/bridge/ClipStoreContext';
import { listenForBridge } from '@/lib/bridge/extension-bridge';
import { applyRelayMode, applyRelayList } from '@/lib/constants';

export function useLibraryBridge() {
  const store = useClipStore();
  const { clips, bridgePresent, pubkey, authMethod, timedOut, categories, bodies,
          setClips, prependClip, addClips, setCategories, addCategories, removeCategory,
          setBridgePresent, setTimedOut,
          removeClips, updateClipNote, setClipBody } = store;

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
      if (msg.type === 'DISCERNED_BRIDGE_CLIP_BODY') {
        setClipBody(msg.id, { bodyHtml: msg.bodyHtml, thumbnail: msg.thumbnail });
      }
      if (msg.type === 'DISCERNED_BRIDGE_RELAYS') {
        // Honour the extension's dev relay mode on /clips too.
        applyRelayMode(msg.mode);
      }
      if (msg.type === 'DISCERNED_BRIDGE_RELAY_LIST') {
        // The extension is the source of truth for the user's relay list —
        // adopt it (it may include relays just discovered from their NIP-65).
        applyRelayList(msg.rows);
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
    bridgePresent, pubkey, authMethod, clips, timedOut, categories, bodies,
    removeClips, updateClipNote, addClips, addCategories, removeCategory,
    setClipBody,
    focusClipId, clearFocusClipId: () => setFocusClipId(null),
  };
}
