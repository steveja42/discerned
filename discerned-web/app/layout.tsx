// Root layout — applies the Editorial design system body class and project metadata.
// All pages share this shell; no navigation chrome is rendered here (TopBar lives per-page).

import type { Metadata } from 'next';
import './globals.css';
import { ClipStoreProvider } from '@/lib/bridge/ClipStoreContext';
import { NostrAuthProvider } from '@/hooks/useNostrAuth';

export const metadata: Metadata = {
  title: 'Discerned — Signal, not noise.',
  description: 'A value-attribution layer for the web. Clip, rate, broadcast.',
};

// Dev-only: detect failed hydration and reload.
//
// On browser-launch tab restore in dev, Chromium serves cached HTML
// (performance.navigation entry type='back_forward', transferSize=0) but the
// embedded React/Next.js chunk references in that HTML don't match the
// current dev bundle's manifest, so hydration silently aborts. The page
// renders but is uninteractive (sign-in does nothing, the extension bridge
// handler never runs). Confirmed by a diagnostic: button elements never gain
// a __reactFiber property even seconds after `load`.
//
// We only reload when hydration has actually failed — checked after `load`
// by probing the DOM for React fibers. Normal back/forward navigations
// within the app (where the bundle hasn't changed) hydrate fine and skip
// the reload. Production HTML is stable across sessions so this is dev-only.
//
// Why DevTools-open at close avoids the problem: Chromium disables cached
// back-forward restore for tabs with DevTools attached.
//
// Safe against loops: once a reload happens, the navigation type becomes
// 'reload' and the bundle matches, so the next hydration succeeds and the
// probe never fires another reload. The sessionStorage guard provides
// belt-and-suspenders in case some edge case keeps hydration failing.
const hydrationReload =
  process.env.NODE_ENV === 'development'
    ? `(function(){
  function isHydrated(){
    var nodes=document.querySelectorAll('button,a,input');
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i];
      for(var j=0,ks=Object.keys(n);j<ks.length;j++){
        if(ks[j].indexOf('__reactFiber')===0)return true;
      }
    }
    return false;
  }
  function check(){
    if(isHydrated())return;
    try{
      var k='__discernedHydrationReload';
      if(sessionStorage.getItem(k))return;
      sessionStorage.setItem(k,'1');
    }catch(e){}
    location.reload();
  }
  addEventListener('load',function(){
    if(isHydrated()){
      try{sessionStorage.removeItem('__discernedHydrationReload');}catch(e){}
      return;
    }
    // Hydration in dev typically completes within ~100-300ms of load. 400ms
    // gives enough headroom to avoid a false-positive reload while keeping
    // the failure-recovery snappy.
    setTimeout(check,400);
  });
})();`
    : null;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="style-editorial">
        {hydrationReload && <script dangerouslySetInnerHTML={{ __html: hydrationReload }} />}
        <NostrAuthProvider>
          <ClipStoreProvider>{children}</ClipStoreProvider>
        </NostrAuthProvider>
      </body>
    </html>
  );
}
