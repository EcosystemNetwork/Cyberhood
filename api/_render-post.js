const { escapeHtml, renderParagraphs, toPlainText, formatPostDate } = require('../post-utils.js');

// Fill p/index.html with one post. Throws if the template no longer has an expected placeholder,
// so the caller can fall back to the client-rendered page.
function renderPostPage(template, post, origin, pathPrefix = '/p/') {
  const title = escapeHtml(post.title);
  const plain = toPlainText(post.body).replace(/\[image: [^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  const desc = escapeHtml(plain.length > 160 ? plain.slice(0, 157) + '...' : plain);
  const img = (String(post.body).match(/!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/) || [])[1];
  const image = escapeHtml(img || origin + '/favicon.png');
  const url = escapeHtml(origin + pathPrefix + post.slug);

  const head = [
    '<title>' + title + " - Taproot's Blog</title>",
    '<meta name="description" content="' + desc + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + desc + '">',
    '<meta property="og:image" content="' + image + '">',
    '<meta property="og:url" content="' + url + '">',
    '<meta name="twitter:card" content="' + (img ? 'summary_large_image' : 'summary') + '">',
  ].join('\n  ');

  const steps = [
    ["<title>Taproot's Blog</title>", head],
    ['<h1 class="blog-post-title" id="post-title"></h1>', '<h1 class="blog-post-title" id="post-title">' + title + '</h1>'],
    ['<div id="post-date" class="article-date"></div>', '<div id="post-date" class="article-date">' + formatPostDate(post.created_at) + '</div>'],
    ['<div class="blog-content" id="post-content"></div>', '<div class="blog-content" id="post-content">' + renderParagraphs(post.body) + '</div>'],
    ['data-slug=""', 'data-slug="' + escapeHtml(post.slug) + '"'],
    ['<script src="/post-page.js"></script>', '<script src="/feedback.js"></script>'],
  ];
  return steps.reduce((html, [from, to]) => {
    if (!html.includes(from)) throw new Error('template missing: ' + from);
    return html.replace(from, () => to);
  }, template);
}

module.exports = { renderPostPage };
