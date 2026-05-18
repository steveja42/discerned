// Role: Onboarding Tab — first-run welcome page
// Description: Instructs the user to pin the Discerned icon to their toolbar.
//              Nostr identity setup happens inline inside the capture overlay.
// Access: none (window.close only)


document.getElementById('btn-done')?.addEventListener('click', () => {
  window.close();
});
