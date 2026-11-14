#!/usr/bin/env node
// Turn a post from the database into a static page: node tools/export-post.js <slug>
// Writes <slug>/index.html (same look as the other posts) and adds it to the home page list.
const fs = require('fs');
const path = require('path');
const { renderPostPage } = require('../api/_render-post.js');
const { escapeHtml, formatPostDate } = require('../post-utils.js');

const root = path.join(__dirname, '..');
const slug = process.argv[2];
if (!/^[a-z0-9-]+$/i.test(slug || '')) { console.error('usage: node tools/export-post.js <slug>'); process.exit(1); }

const config = fs.readFileSync(path.join(root, 'supabase-config.js'), 'utf8');
const url = config.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const key = config.match(/ANON_KEY\s*=\s*'([^']+)'/)[1];

(async () => {
  const r = await fetch(`${url}/rest/v1/posts?select=slug,title,category,body,created_at&slug=eq.${slug}&limit=1`,
    { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  const post = (await r.json())[0];
  if (!post) { console.error('no post with slug ' + slug); process.exit(1); }

  const template = fs.readFileSync(path.join(root, 'p', 'index.html'), 'utf8');
  fs.mkdirSync(path.join(root, slug), { recursive: true });
  fs.writeFileSync(path.join(root, slug, 'index.html'), renderPostPage(template, post, 'https://taproot.love', '/'));

  // Add to the home page list (newest first) unless it is already there.
  const indexPath = path.join(root, 'index.html');
  let index = fs.readFileSync(indexPath, 'utf8');
  if (index.includes(`href="/${slug}"`)) { console.log(`${slug}/index.html written (already on home page)`); return; }
  const title = post.category[0].toUpperCase() + post.category.slice(1);
  const section = new RegExp(`(<h2 class="category-title">${title}</h2>\\s*<ul class="list">)([\\s\\S]*?)(</ul>)`);
  const m = index.match(section);
  if (!m) throw new Error('category not found on home page: ' + title);
  const when = new Date(post.created_at).getTime();
  const li = `<li class="list-item">\n          <a href="/${slug}">${escapeHtml(post.title)}</a>\n          <span class="article-date">${formatPostDate(post.created_at)}</span>\n        </li>\n        `;
  const items = m[2].match(/<li class="list-item">[\s\S]*?<\/li>\n?/g) || [];
  const older = items.find((it) => Date.parse(it.match(/article-date">([^<]*)</)[1]) < when);
  const list = older ? m[2].replace(older, li + older) : m[2].replace(/\s*$/, '\n        ') + li.trimEnd() + '\n      ';
  index = index.replace(section, (_, a, __, c) => a + list + c);
  fs.writeFileSync(indexPath, index);
  console.log(`${slug}/index.html written and added to the home page`);
})();
