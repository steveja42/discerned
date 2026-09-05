// Click-to-play: map a captured video URL to a privacy-conscious embed.
//
// A clip stores a poster image plus the video's canonical URL — never the video
// bytes. The bytes are unstorable: platform CDNs serve them behind expiring
// signed tokens (an fbcdn/cdninstagram URL 403s within days), and a `blob:` MSE
// source dies with the tab it was captured in. So playback has to come from the
// platform's own embed player, resolved from the canonical URL at view time.
//
// Nothing loads until the viewer clicks. That keeps a library of clips fast, and
// means opening a clip does not silently tell YouTube/Instagram/etc. that this
// person is looking at it — the network request only happens on an explicit
// play. Where a provider offers a no-cookie host (YouTube), it is preferred.

export interface VideoEmbed {
  /** URL for the <iframe> that plays the video inline. */
  embedUrl: string;
  /** Human label for the provider, e.g. "YouTube". */
  provider: string;
  /** Canonical watch page, for the "open on <provider>" fallback link. */
  href: string;
}

/**
 * Resolve a canonical media URL to an inline embed, or null when the provider
 * is unknown or offers no embeddable player. Callers must treat null as "keep
 * the existing link-out card" — never as an error.
 */
export function resolveVideoEmbed(rawUrl: string): VideoEmbed | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // YouTube — youtu.be/<id>, /watch?v=<id>, /embed/<id>, /shorts/<id>.
  // youtube-nocookie.com does not set tracking cookies until playback starts.
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (isYouTubeId(id)) return youtube(id, u.searchParams.get('t'));
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    const fromQuery = u.searchParams.get('v');
    if (fromQuery && isYouTubeId(fromQuery)) return youtube(fromQuery, u.searchParams.get('t'));
    const m = u.pathname.match(/^\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{6,})/);
    if (m && isYouTubeId(m[1])) return youtube(m[1], u.searchParams.get('t'));
  }

  // Vimeo — /<id> on the site, /video/<id> on the player host.
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = u.pathname.match(/(?:^|\/video\/|\/)(\d{6,})/)?.[1];
    if (id) {
      return {
        embedUrl: `https://player.vimeo.com/video/${id}`,
        provider: 'Vimeo',
        href: `https://vimeo.com/${id}`,
      };
    }
  }

  // Instagram — /p/, /reel/, /reels/ and /tv/ all embed through /<kind>/<code>/embed.
  // `/reels/` (plural) is the player ROUTE; the embeddable canonical form is the
  // singular `/reel/`, which is what Instagram's own rel=canonical reports.
  if (host === 'instagram.com') {
    const m = u.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (m) {
      const kind = m[1] === 'p' ? 'p' : m[1] === 'tv' ? 'tv' : 'reel';
      const canonical = `https://www.instagram.com/${kind}/${m[2]}/`;
      // NOTE: Instagram serves NO media-only embed. Measured, both routes
      // render the full post card — profile header, "View profile", "View more
      // on Instagram", the like/comment bar and a comment box — and
      // `embed/captioned` is strictly worse (adds the caption, taller). So the
      // surrounding chrome is cropped on our side; see .clip-video-embed's
      // Instagram rules in globals.css.
      return {
        embedUrl: `${canonical}embed/`,
        provider: 'Instagram',
        href: canonical,
      };
    }
  }

  // TikTok — /@user/video/<id>; the embed player is keyed on the id alone.
  if (host === 'tiktok.com') {
    const id = u.pathname.match(/\/video\/(\d{6,})/)?.[1];
    if (id) {
      return {
        embedUrl: `https://www.tiktok.com/embed/v2/${id}`,
        provider: 'TikTok',
        href: rawUrl,
      };
    }
  }

  // X / Twitter — the platform embed renders the whole tweet, video included.
  if (host === 'twitter.com' || host === 'x.com') {
    const id = u.pathname.match(/\/status\/(\d{6,})/)?.[1];
    if (id) {
      return {
        embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${id}`,
        provider: 'X',
        href: rawUrl,
      };
    }
  }

  // Facebook — reels/videos/watch all play through the video plugin.
  if (host === 'facebook.com' || host === 'fb.watch') {
    if (/^\/(reel|watch|video|[^/]+\/videos)\b/.test(u.pathname) || host === 'fb.watch') {
      return {
        embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(rawUrl)}&show_text=false`,
        provider: 'Facebook',
        href: rawUrl,
      };
    }
  }

  // Rumble / Odysee / Twitch / Dailymotion — already-embeddable player URLs are
  // passed through; their watch-page forms carry no derivable player path.
  if (host === 'rumble.com' && u.pathname.startsWith('/embed/')) {
    return { embedUrl: rawUrl, provider: 'Rumble', href: rawUrl };
  }
  if (host.endsWith('odysee.com') && u.pathname.startsWith('/$/embed/')) {
    return { embedUrl: rawUrl, provider: 'Odysee', href: rawUrl };
  }
  if (host === 'dailymotion.com' || host === 'geo.dailymotion.com') {
    const id = u.pathname.match(/\/video\/([A-Za-z0-9]+)/)?.[1];
    if (id) {
      return {
        embedUrl: `https://geo.dailymotion.com/player.html?video=${id}`,
        provider: 'Dailymotion',
        href: `https://www.dailymotion.com/video/${id}`,
      };
    }
  }

  return null;
}

/** A YouTube id is 11 chars of the URL-safe alphabet; anything else is a path. */
function isYouTubeId(s: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(s);
}

function youtube(id: string, t: string | null): VideoEmbed {
  // `t` may be "90" or "1m30s"; the embed player wants plain seconds.
  const start = t ? parseTimecode(t) : 0;
  const qs = new URLSearchParams({ autoplay: '1', rel: '0' });
  if (start > 0) qs.set('start', String(start));
  return {
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?${qs}`,
    provider: 'YouTube',
    href: `https://www.youtube.com/watch?v=${id}`,
  };
}

function parseTimecode(t: string): number {
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
}
