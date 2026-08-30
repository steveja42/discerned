// Role: Onboarding Tab — first-run welcome page
// Description: Instructs the user to pin the Discerned icon to their toolbar, and
//              asks once for the optional host permission that lets clips store
//              their own copy of each image.
// Access: window.close; chrome.storage.local (theme preference) via initPageTheme();
//         chrome.permissions (request/contains — this page is a valid gesture context).

import { initPageTheme } from '@/shared/theme';

initPageTheme();

document.getElementById('btn-done')?.addEventListener('click', () => {
  window.close();
});

// ── Optional image-inlining permission ──────────────────────────────────────
//
// Baking images into a clip needs a cross-origin fetch to whichever hosts the
// page's images live on — an unbounded set, so it's <all_urls> and optional
// rather than a manifest host permission. chrome.permissions.request() must be
// called from a foreground gesture context: this page qualifies, the background
// service worker does not.

const permBlock = document.getElementById('perm-block');
const permBtn = document.getElementById('btn-perm') as HTMLButtonElement | null;
const permStatus = document.getElementById('perm-status');

function showGranted(): void {
  if (permBtn) {
    permBtn.disabled = true;
    permBtn.textContent = 'Images will be saved';
  }
  if (permStatus) {
    permStatus.hidden = false;
    permStatus.textContent = 'Your clips will keep their own copy of each image.';
  }
}

function showDeclined(): void {
  if (permStatus) {
    permStatus.hidden = false;
    permStatus.textContent =
      'No problem — images are still saved on most sites. On the few that don\'t '
      + 'allow it, clips will link to the original image instead. You can change '
      + 'this later in the extension\'s settings.';
  }
}

// Hide the whole ask if it's already granted (a reinstall keeps the grant, and a
// re-opened onboarding tab shouldn't ask for something the user already allowed).
void chrome.permissions.contains({ origins: ['<all_urls>'] }).then(granted => {
  if (granted) showGranted();
}).catch(() => {
  // Non-fatal — leave the ask visible.
});

permBtn?.addEventListener('click', () => {
  // No await before request() — the user-gesture token must still be live.
  chrome.permissions.request({ origins: ['<all_urls>'] }).then(granted => {
    if (granted) showGranted();
    else showDeclined();
  }).catch(() => {
    if (permStatus) {
      permStatus.hidden = false;
      permStatus.textContent = 'Could not complete that request. You can turn it on later in settings.';
    }
  });
});

// Keep the block out of the layout entirely if the permissions API is somehow
// unavailable, rather than showing a button that can't do anything.
if (!chrome.permissions && permBlock) {
  permBlock.hidden = true;
}
