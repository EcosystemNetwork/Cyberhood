const fs = require('fs');
const path = require('path');
const { renderPostPage } = require('./_render-post.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://azvdqigaqwbeakjieaps.supabase.co';
// The public anon key already ships to browsers in supabase-config.js.
const ANON_KEY = (fs.readFileSync(path.join(__dirname, '..', 'supabase-config.js'), 'utf8').match(/ANON_KEY\s*=\s*'([^']+)'/) || [])[1];
const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'p', 'index.html'), 'utf8');

module.exports = async (req, res) => {
  const slug = String((req.query && req.query.slug) || '');
  const origin = 'https://' + req.headers.host;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Anything unexpected: serve the old client-rendered page, uncached, so the post still loads.
  const fallback = () => { res.setHeader('Cache-Control', 'no-store'); res.status(200).send(TEMPLATE); };
  if (!/^[a-z0-9-]+$/i.test(slug)) return fallback();

  let rows;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/posts?select=slug,title,body,created_at&slug=eq.' + slug + '&limit=1',
      { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } });
    if (!r.ok) return fallback();
    rows = await r.json();
  } catch (e) { return fallback(); }

  // Missing post: let the client page show "Post not found", but don't cache it long (the post may be published soon).
  if (!rows.length) { res.setHeader('Cache-Control', 'public, s-maxage=30'); return res.status(404).send(TEMPLATE); }

  let html;
  try { html = renderPostPage(TEMPLATE, rows[0], origin); } catch (e) { return fallback(); }
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(html);
};
