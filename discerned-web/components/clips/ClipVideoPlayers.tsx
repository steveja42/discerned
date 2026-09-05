'use client';

import { useEffect, useRef } from 'react';
import { resolveVideoEmbed } from '@/lib/video-embed';

/**
 * Make captured video posters playable in place.
 *
 * A clip body is injected as raw HTML (dangerouslySetInnerHTML), so the poster
 * cards inside it are outside React's tree and cannot carry an onClick. This
 * hook attaches ONE delegated listener on the container instead, which also
 * means it keeps working when the body is swapped for a different clip.
 *
 * Only the click is intercepted — nothing is prefetched, and no iframe exists
 * until the viewer asks for one. Cards whose URL no provider recognises are
 * left completely alone and keep their normal open-in-new-tab behaviour.
 */
/**
 * Show `player` in place of `card` WITHOUT removing the card.
 *
 * The poster cards live inside a `dangerouslySetInnerHTML` body, so React
 * believes it owns them. Replacing one desynchronises React's virtual tree
 * from the real DOM, and its next reconciliation throws
 * "Failed to execute 'removeChild': The node to be removed is not a child of
 * this node." Hiding the card and inserting the player next to it keeps every
 * React-owned node exactly where React left it, so reconciliation stays valid.
 */
function mountPlayer(card: Element, player: HTMLElement): void {
  (card as HTMLElement).style.display = 'none';
  card.setAttribute('data-dx-player-open', '1');
  card.after(player);
}

/**
 * Undo `mountPlayer`: drop the player we inserted (ours, so removing it is
 * safe) and reveal the card again. Never touches React's node beyond a style.
 */
function unmountPlayer(card: Element | null, player: Element): void {
  player.remove();
  if (card) {
    (card as HTMLElement).style.removeProperty('display');
    card.removeAttribute('data-dx-player-open');
  }
}

export function useClipVideoPlayers(
  ref: React.RefObject<HTMLElement | null>,
  deps: unknown[] = [],
  /**
   * Identity of the item currently shown. Players belong to ONE item, so this
   * is what tells the restore logic when its registry has gone stale. Without
   * it, playing a video in one cast and switching to another re-inserted the
   * FIRST cast's player into the second — the registry is keyed by card href,
   * and a different cast can legitimately carry the same video link.
   */
  itemId?: string | null,
): void {
  // Players swapped in, keyed by the card href they replaced, so a re-render
  // that restores the original markup can be undone without rebuilding (and
  // therefore restarting) the iframe.
  //
  // Held in a ref, NOT inside the effect: the effect re-runs whenever `deps`
  // change — which a remount does — and a map declared inside it was discarded
  // each time, taking the record of every live player with it. The observer
  // then had nothing to restore and the video appeared to restart.
  const activePlayersRef = useRef<Map<string, Element>>(new Map());
  const ownerIdRef = useRef<string | null | undefined>(itemId);

  useEffect(() => {
    // A different item is on screen: its players are not ours. Drop them so a
    // previous cast's iframe can never be re-inserted into this one, and stop
    // any media still playing inside them (an orphaned iframe keeps its audio
    // going otherwise, since nothing else holds a reference to it).
    if (ownerIdRef.current !== itemId) {
      for (const node of activePlayersRef.current.values()) {
        // The hidden card sits immediately before the player we inserted.
        const card = node.previousElementSibling?.hasAttribute('data-dx-player-open')
          ? node.previousElementSibling
          : null;
        unmountPlayer(card, node);
      }
      activePlayersRef.current.clear();
      ownerIdRef.current = itemId;
    }
    const activePlayers = activePlayersRef.current;

    // Bound to the DOCUMENT, not to ref.current, and scoped by a containment
    // test at click time. Binding to the ref meant the effect no-opped whenever
    // it ran before the body element existed, and it only retried when `deps`
    // happened to change — so the FIRST click was frequently swallowed and the
    // video needed a second one. Delegating from the document removes that
    // ordering dependency entirely: the listener is always live, and the
    // containment check still keeps it scoped to this panel's body.
    const onClick = (e: MouseEvent) => {
      // Respect the ways a person asks for a new tab/window.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const card = target?.closest?.('a.tweet-video, a.dx-video-link');
      // Resolve the body fresh: after a re-render `ref.current` is a detached
      // div, so a containment test against it rejects every real click.
      const root = card?.closest('.clip-body') ?? ref.current;
      if (!card || !root || !root.contains(card)) return;
      // A hidden card whose player is already showing must not mount a second
      // one (it stays in the DOM now rather than being replaced).
      if (card.hasAttribute('data-dx-player-open')) return;

      const href = card.getAttribute('href') ?? '';
      const embed = resolveVideoEmbed(href);
      if (!embed) return; // Unknown provider — let the link open normally.

      e.preventDefault();

      // Carry the POSTER's aspect ratio into the player. A fixed 16/9 frame
      // letterboxes a 9:16 reel into a thin band with black bars either side,
      // which is both smaller than the poster it replaced and the wrong shape.
      // The poster is the most reliable signal we have for the video's real
      // proportions; fall back to 16/9 only when it can't be measured.
      // Prefer the poster's INTRINSIC size. Its rendered box is shaped by the
      // clip's own CSS (a letterboxed thumbnail, a capped height), so measuring
      // that produced a squat frame with heavy black bars; naturalWidth is the
      // image itself. YouTube's hqdefault is 4:3 with baked-in bars, so a
      // near-4:3 poster is treated as the 16:9 video it actually is.
      const poster = card.querySelector('img');
      let pw = poster?.naturalWidth || parseInt(poster?.getAttribute('width') ?? '', 10);
      let ph = poster?.naturalHeight || parseInt(poster?.getAttribute('height') ?? '', 10);
      if (Number.isFinite(pw) && Number.isFinite(ph) && pw > 0 && ph > 0) {
        const r = pw / ph;
        if (r > 1.2 && r < 1.5) { pw = 16; ph = 9; }
      } else {
        pw = 16; ph = 9;
      }
      const ratio = `${pw} / ${ph}`;

      const frame = document.createElement('iframe');
      frame.src = embed.embedUrl;
      frame.className = 'clip-video-frame';
      frame.style.aspectRatio = ratio;
      // Bound the WRAPPER's width to whatever the height cap allows at this
      // ratio. An iframe cannot letterbox its own content (object-fit does
      // nothing here), so capping the frame's height alone left the width at
      // 100% and stretched a portrait video into a wide box. Constraining the
      // width instead lets the ratio produce the right height for free.
      // Cap by HEIGHT. Measure the space the player actually has rather than
      // assuming a fixed chrome offset: in fullscreen the panel's header and
      // metadata sit above the body, and a guessed subtraction left a portrait
      // reel taller than the viewport. The card's own top is the real budget.
      const cardTop = card.getBoundingClientRect().top;
      const scroller = card.closest('.clip-body')?.parentElement;
      const available = (scroller?.getBoundingClientRect().bottom ?? window.innerHeight) - cardTop;
      const capPx = Math.max(240, Math.min(available - 48, window.innerHeight * 0.82, 900));
      frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
      frame.setAttribute('allowfullscreen', 'true');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.setAttribute('title', `${embed.provider} video player`);

      // Keep a way out: an embed can fail to load (age-gated, region-blocked,
      // embedding disabled by the uploader) and an iframe gives no reliable
      // error event, so the link out is always rendered beneath the player
      // rather than only on failure.
      //
      // Instagram specifically: SOME reels embed with a real <video> and play
      // inline, others ship a poster plus a "Play / Watch on Instagram"
      // click-through with NO <video> at all (measured on two reels — one of
      // each). Which one you get is Instagram's choice per post and cannot be
      // detected in advance: the embed is cross-origin, so its DOM is
      // unreadable from here until it has already been loaded and clicked.
      // Hence the link below is not a fallback for failure but a permanent
      // affordance — for those posts it is the only way to watch.
      const wrap = document.createElement('div');
      wrap.className = 'clip-video-embed';
      // Instagram serves no media-only embed: every route renders the full
      // post card (profile header above; "View more on Instagram", the
      // like/comment bar and a comment box below). Measured at 420px wide, the
      // video sits at top 54 / height 525 in a 760px document — i.e. the
      // header is ~12.9% of the width and the footer chrome ~43% — so the
      // frame is oversized and shifted up inside a clipping wrapper, leaving
      // just the player visible.
      if (embed.provider === 'Instagram') {
        // Measured across 320/400/520px wide: the header is a CONSTANT 54px at
        // every width (not a proportion), and the player is always width×1.25.
        // The footer chrome is likewise fixed-height. So the crop is expressed
        // in pixels for the header and derived from the wrapper's own width for
        // the player band — a width-proportional shift was wrong and left the
        // like bar and comment box visible below the video.
        wrap.classList.add('clip-video-embed--crop');
        wrap.style.setProperty('--dx-crop-header', '54px');
        // aspect-ratio is width/height, and the player's height is width x1.25.
        wrap.style.setProperty('--dx-crop-player-ar', String(1 / 1.25));
      }
      // Width is derived from whichever ratio actually GOVERNS the box height.
      // For a cropped embed that is the crop band (width x1.25), not the
      // video's own ratio — sizing the width from the video made the box
      // shorter than the space available, which is why the player did not use
      // the full height and sat in a tall column with bars around it.
      const boxAr = wrap.classList.contains('clip-video-embed--crop')
        ? 1 / 1.25
        : pw / ph;
      const wrapMaxWidth = Math.round(capPx * boxAr);
      wrap.style.maxWidth = `${wrapMaxWidth}px`;
      // The governing ratio, for the fullscreen rule to re-derive a width from
      // the taller height budget it has available.
      wrap.style.setProperty('--dx-box-ar', String(boxAr));
      // Fullscreen CSS scales this ratio-correct width instead of assuming a
      // shape, so a portrait reel grows without being widened into a letterbox.
      // Fullscreen CSS turns an available HEIGHT into a width using this
      // ratio, so the player fills the window without ever exceeding it.
      wrap.style.setProperty('--dx-embed-ar', String(pw / ph));
      wrap.appendChild(frame);
      const out = document.createElement('a');
      out.href = embed.href;
      out.target = '_blank';
      out.rel = 'noopener noreferrer';
      out.className = 'clip-video-out';
      out.textContent = `Open on ${embed.provider}`;
      if (wrap.classList.contains('clip-video-embed--crop')) {
        // The crop box clips to the player (overflow: hidden), so the link
        // cannot live inside it — it would be cropped away with the chrome.
        // Wrap both in a row instead.
        const row = document.createElement('div');
        row.className = 'clip-video-crop-row';
        row.style.maxWidth = wrap.style.maxWidth;
        row.appendChild(wrap);
        row.appendChild(out);
        mountPlayer(card, row);
        activePlayers.set(href, row);
        return;
      }
      wrap.appendChild(out);
      mountPlayer(card, wrap);
      activePlayers.set(href, wrap);
    };

    // Re-apply an active player after React rewrites the body.
    //
    // The clip body is injected with dangerouslySetInnerHTML inside an inline
    // IIFE, so any state change on the panel — toggling fullscreen is the one
    // people hit — can re-render that subtree and restore the ORIGINAL html,
    // discarding the iframe we swapped in. The video then appears to stop
    // playing when entering fullscreen. (Measured: the resize itself does not
    // pause Instagram's player, and the iframe is not reloaded by the class
    // change — so the remount is the only remaining cause.)
    //
    // Rather than fight the re-render, watch for it: if a poster card
    // reappears where a player is active, put the player back. The iframe
    // element is REUSED, not recreated, so playback position survives.
    // Look the body up fresh each time: `ref.current` points at the div that
    // existed when the effect ran, which a re-render has already discarded.
    const restorePlayers = () => {
      const root = document.querySelector('.detail .clip-body') ?? ref.current;
      if (!root) return;
      for (const [href, node] of activePlayers) {
        if (root.contains(node)) continue; // still mounted — nothing to do
        const card = Array.from(root.querySelectorAll('a.tweet-video, a.dx-video-link'))
          .find(a => a.getAttribute('href') === href);
        // Re-attach beside the card rather than replacing it, for the same
        // reason as the initial mount: React owns the card.
        if (card) mountPlayer(card, node as HTMLElement);
      }
    };
    // Run once on setup as well as on mutations: when the effect re-runs
    // BECAUSE of a re-render, React has already rewritten the body before the
    // observer exists, so there is no mutation left to react to.
    restorePlayers();
    const observer = new MutationObserver(restorePlayers);
    // Observe a STABLE ancestor, not ref.current. React re-renders the body by
    // replacing that div wholesale, so an observer bound to it would be
    // watching a detached node and never see the replacement — which is why
    // the player still had to be clicked again after entering fullscreen.
    // The panel <aside> survives the toggle (only its class changes).
    const host = ref.current?.closest('.detail') ?? document.body;
    observer.observe(host, { childList: true, subtree: true });

    document.addEventListener('click', onClick);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', onClick);
    };
    // itemId is included so switching items always re-runs the effect and hits
    // the ownership check above, even if the caller's own deps happen to match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, itemId]);
}
