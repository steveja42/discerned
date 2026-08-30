// Role: Permissions page — grants that require an extension-page context
// Description: Hosts the optional <all_urls> grant used for saving images into
//              clips. chrome.permissions is NOT exposed to content scripts and
//              the prompt must be triggered by a gesture on an extension page,
//              so the overlay's Settings drawer links here rather than asking
//              inline (see overlay.ts → initImagePermissionCard). Deliberately
//              NOT called "settings": that name already means the overlay drawer
//              and the web app's own settings.
// Access: chrome.permissions (contains/request), chrome.storage.local (theme).

import { initPageTheme } from '@/shared/theme';

initPageTheme();

const ORIGINS = { origins: ['<all_urls>'] };

const btn = document.getElementById('btn-perm') as HTMLButtonElement | null;
const status = document.getElementById('perm-status');
const revokeHint = document.getElementById('revoke-hint');

function render(granted: boolean): void {
  if (btn) {
    btn.disabled = granted;
    btn.textContent = granted ? 'Images are being saved' : 'Save images in my clips';
  }
  if (status) {
    status.hidden = false;
    status.className = granted ? 'status ok' : 'status';
    status.textContent = granted
      ? 'Your clips keep their own copy of each image.'
      : 'Clips currently link to images on the original site.';
  }
  if (revokeHint) revokeHint.hidden = !granted;
}

void chrome.permissions.contains(ORIGINS)
  .then(render)
  .catch(() => render(false));

btn?.addEventListener('click', () => {
  // No await before request() — the user-gesture token must still be live.
  chrome.permissions.request(ORIGINS).then((granted) => {
    if (granted) {
      render(true);
      return;
    }
    if (status) {
      status.hidden = false;
      status.className = 'status';
      status.textContent =
        'Not allowed, so clips will keep linking to the original images. '
        + 'If Chrome did not show a prompt, it may have remembered an earlier '
        + 'refusal — you can grant access from chrome://extensions → Discerned '
        + '→ Details → Site access → On all sites.';
    }
  }).catch(() => {
    if (status) {
      status.hidden = false;
      status.textContent = 'Could not complete that request.';
    }
  });
});

// Reflect a change made elsewhere (chrome://extensions, or another tab).
chrome.permissions.onAdded.addListener(() => render(true));
chrome.permissions.onRemoved.addListener(() => render(false));
