// Role: Popup — restricted-page stub controller
// Description: This popup only appears on tabs where content scripts can't run (chrome://,
//              file://, edge://, the Web Store). Background.ts toggles default_popup per-tab
//              via chrome.action.setPopup; on every other page the toolbar icon launches the
//              full overlay instead. The auth, stats, and export UI that used to live here
//              has moved into the overlay's settings drawer.
// Access: chrome.storage.local (theme preference) via initPageTheme().

import { initPageTheme } from '@/shared/theme';

initPageTheme();

