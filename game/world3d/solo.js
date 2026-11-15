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
  const api = { SOLO, soloKey, withSolo, installSolo };
  Object.assign(globalThis, api);
  if (typeof module !== 'undefined') module.exports = api;
})();
