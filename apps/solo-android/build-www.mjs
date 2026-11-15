// Copies the solo game into www/ for the Android app: every file on the offline list
// (game/solo-sw-files.js), with the CDN scripts downloaded into www/vendor/ and links
// rewritten to them, so the app needs no internet at all.  Run: npm run build
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ROOT = new URL('../../', import.meta.url), WWW = new URL('www/', import.meta.url);
const CDN = 'https://cdn.jsdelivr.net/npm/';
const self = {};
new Function('self', readFileSync(new URL('game/solo-sw-files.js', ROOT), 'utf8'))(self);

const put = (rel, data) => { const u = new URL(rel, WWW); mkdirSync(dirname(u.pathname), { recursive: true }); writeFileSync(u, data); };
const local = (src) => src.replaceAll(CDN, '/vendor/');

rmSync(WWW, { recursive: true, force: true });
for (const f of self.SOLO_FILES) {
  if (f.startsWith(CDN)) { put('vendor/' + f.slice(CDN.length), local(await (await fetch(f)).text())); continue; }
  if (f.endsWith('/')) continue; // the page itself is copied as its index.html
  const rel = f.slice(1);
  if (/\.(js|html)$/.test(f)) put(rel, local(readFileSync(new URL(rel, ROOT), 'utf8')));
  else { mkdirSync(dirname(new URL(rel, WWW).pathname), { recursive: true }); copyFileSync(new URL(rel, ROOT), new URL(rel, WWW)); }
}
// The app's web server answers any folder address (/game/sea3d/?...) with this root page, so it
// forwards to that folder's index.html, keeping the query; the bare app start goes to solo.
put('index.html', '<!doctype html><meta charset="utf-8"><script>const p = location.pathname === "/" ? "/game/world3d/" : location.pathname.replace(/\\/?$/, "/");' +
  'location.replace(p + "index.html" + (location.search || "?solo=1"))</script>');
console.log(`www ready: ${self.SOLO_FILES.length} files`);
