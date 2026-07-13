// Static server shell for the Discerns feed route (/discerns). Delegates all
// client behaviour (Nostr feed, auth, first-visit popover) to DiscernsClient.

import DiscernsClient from './DiscernsClient';

export default function Discerns() {
  return <DiscernsClient />;
}
