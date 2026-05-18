// Static server shell for the home route (/). Delegates all client behaviour
// (Nostr feed, auth, first-visit popover) to HomeClient.

import HomeClient from './HomeClient';

export default function Home() {
  return <HomeClient />;
}
