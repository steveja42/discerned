// Role: Popup — restricted-page stub controller
// Description: This popup only appears on tabs where content scripts can't run (chrome://,
//              file://, edge://, the Web Store). Background.ts toggles default_popup per-tab
//              via chrome.action.setPopup; on every other page the toolbar icon launches the
//              full overlay instead. The auth, stats, and export UI that used to live here
//              has moved into the overlay's settings drawer.
// Access: shared logger only; no DOM logic needed beyond the static HTML stub.

