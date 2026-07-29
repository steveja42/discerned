// Dump the most recent Discerned cast events from the local relay for verification.
//
//   node tools/dump-casts.mjs            # 2 most recent #discerned kind-1 + kind-30023
//   node tools/dump-casts.mjs 30023      # 2 most recent long-form events
//   node tools/dump-casts.mjs 1          # 2 most recent notes
//   node tools/dump-casts.mjs 0          # 2 most recent profiles (metadata parsed)
//   COUNT=5 node tools/dump-casts.mjs    # override how many to print
//   RELAY=ws://localhost:7777 node tools/dump-casts.mjs
//
// Uses Node's built-in WebSocket (Node 22+). Prints each matching event as
// pretty JSON, newest first, then exits.

const RELAY = process.env.RELAY || 'ws://localhost:7777';
const COUNT = Number(process.env.COUNT) || 2;
const kindArg = process.argv[2];
const kinds = kindArg ? [Number(kindArg)] : [1, 30023];

// Ask for a few extra so sorting by created_at picks the true newest COUNT.
// Kind-0 profiles carry no `t` tag, so the #discerned filter would exclude them.
const filter = { kinds, limit: Math.max(COUNT * 5, 20) };
if (!kinds.includes(0)) filter['#t'] = ['discerned'];
const subId = 'dump-' + Math.random().toString(36).slice(2);

const ws = new WebSocket(RELAY);
const events = [];

ws.addEventListener('open', () => {
  console.error(`[dump] connected ${RELAY}, asking for kinds ${kinds.join(',')} #discerned`);
  ws.send(JSON.stringify(['REQ', subId, filter]));
});

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data.toString()); } catch { return; }
  if (msg[0] === 'EVENT' && msg[1] === subId) {
    events.push(msg[2]);
  } else if (msg[0] === 'EOSE' && msg[1] === subId) {
    ws.send(JSON.stringify(['CLOSE', subId]));
    events.sort((a, b) => b.created_at - a.created_at);
    const recent = events.slice(0, COUNT);
    console.error(`[dump] ${recent.length} most-recent of ${events.length} event(s):\n`);
    for (const ev of recent) {
      // A kind-0's `content` is a JSON *string*; print it parsed so the profile
      // fields are readable instead of one escaped blob.
      if (ev.kind === 0) {
        let meta;
        try { meta = JSON.parse(ev.content); } catch { meta = null; }
        console.log(JSON.stringify({ ...ev, content: meta ?? ev.content }, null, 2));
      } else {
        console.log(JSON.stringify(ev, null, 2));
      }
      console.log('─'.repeat(60));
    }
    ws.close();
    process.exit(0);
  }
});

ws.addEventListener('error', (e) => { console.error('[dump] error:', e.message ?? e.type); process.exit(1); });
setTimeout(() => { console.error('[dump] timeout — no EOSE from relay'); process.exit(1); }, 8000);
