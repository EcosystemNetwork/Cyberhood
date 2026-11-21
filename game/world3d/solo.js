// Solo mode (?solo=1): play with no account and no multiplayer. Every save key is quietly
// prefixed, so solo progress lives apart from the online game without touching any save code.
(function () {
  const PREFIX = 'taproot_solo:';
  const SOLO = new URLSearchParams((globalThis.location && location.search) || '').get('solo') === '1';
  const soloKey = (k) => (String(k).startsWith(PREFIX) ? String(k) : PREFIX + k);
  // add solo=1 to a link so the next page stays in solo
  const withSolo = (href) => {
    if (!SOLO || /[?&]solo=1(&|#|$)/.test(href)) return href;
    const [path, hash] = href.split('#');
    return path + (path.includes('?') ? '&' : '?') + 'solo=1' + (hash !== undefined ? '#' + hash : '');
  };
  const installSolo = (proto) => {
    if (!SOLO) return;
    for (const m of ['getItem', 'setItem', 'removeItem']) {
      const orig = proto[m];
      proto[m] = function (k, ...rest) { return orig.call(this, soloKey(k), ...rest); };
    }
  };
  if (typeof Storage !== 'undefined') installSolo(Storage.prototype);
  // installable + offline: the app manifest, and a service worker that saves the game on the phone
  if (SOLO && typeof document !== 'undefined') {
    const link = document.createElement('link');
    link.rel = 'manifest'; link.href = '/game/solo.webmanifest';
    document.head.appendChild(link);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/game/solo-sw.js', { scope: '/game/' }).catch(() => {});
    // plain links (e.g. the boat's Leave) stay in solo too
    addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href^="/game/"]'); if (a) a.href = withSolo(a.getAttribute('href')); }, true);
    // our own Install button: Chrome's menu entry is easy to miss. It shows only once Chrome
    // says the game can be installed, and goes away once it is.
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      const b = document.createElement('button');
      b.textContent = '\u{1F4F2} Install';
      b.style.cssText = 'position:fixed;z-index:30;left:50%;top:12px;transform:translateX(-50%);padding:8px 18px;border-radius:999px;border:3px solid #2a0a3a;' +
        "font:16px 'Lilita One',system-ui,sans-serif;color:#1e3000;background:linear-gradient(#e6ff7a,#a8e000);box-shadow:0 3px 0 #5a7a00;";
      b.onclick = async () => { b.remove(); e.prompt(); };
      document.body.appendChild(b);
    }, { once: true });
  }
  const api = { SOLO, soloKey, withSolo, installSolo };
  Object.assign(globalThis, api);
  if (typeof module !== 'undefined') module.exports = api;
})();
