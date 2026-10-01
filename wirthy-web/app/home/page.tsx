// Static server shell for the Home feed route (/home). Delegates all
// client behaviour (Nostr feed, auth, first-visit popover) to HomeClient.

import HomeClient from './HomeClient';

export default function Home() {
  return <HomeClient />;
}
