// Role: Offscreen document — decodes a video frame for a clip poster
// Description: A page's CSP can forbid blob: media (deepmind.google's media-src
//              does), which blocks decoding a fetched video inside the page. This
//              extension page is not subject to the site's CSP and, with the
//              optional <all_urls> grant, can fetch the video cross-origin.
// Access: chrome.runtime (messages from background.ts only).

import type { OffscreenVideoFrameRequest } from '@/shared/types';

/** Leading bytes fetched: enough for the header and first keyframe of a faststart MP4. */
const RANGE_BYTES = 524_288;

async function grabFrame(req: OffscreenVideoFrameRequest): Promise<{ dataUri?: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  let blob: Blob;
  try {
    const res = await fetch(req.src, { signal: ctrl.signal, headers: { Range: `bytes=0-${RANGE_BYTES - 1}` } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    blob = await res.blob();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      const abort = setTimeout(() => resolve({ error: 'decode timeout' }), 5_000);
      v.onerror = () => { clearTimeout(abort); resolve({ error: `decode error ${v.error?.code ?? ''}` }); };
      v.addEventListener('loadedmetadata', () => {
        // An unloaded page video reports time 0; step in, since frame 0 is often black.
        v.currentTime = req.currentTime > 0 ? req.currentTime : Math.min(0.1, (v.duration || 1) / 2);
      }, { once: true });
      v.onseeked = () => {
        clearTimeout(abort);
        const c = document.createElement('canvas');
        c.width = req.width || v.videoWidth;
        c.height = req.height || v.videoHeight;
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
        const uri = c.toDataURL('image/jpeg', 0.85);
        resolve(uri && uri !== 'data:,' ? { dataUri: uri } : { error: 'empty frame' });
      };
      v.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenVideoFrameRequest, _sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_VIDEO_FRAME') return false;
  grabFrame(message).then(sendResponse);
  return true;
});
