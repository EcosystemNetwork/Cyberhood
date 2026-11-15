const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, renderParagraphs, toPlainText, formatPostDate } = require('../post-utils.js');

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('My New Post'), 'my-new-post');
});

test('slugify collapses punctuation and trims hyphens', () => {
  assert.equal(slugify('  Foid Debasement: Theory!! '), 'foid-debasement-theory');
});

test('slugify handles repeated separators', () => {
  assert.equal(slugify('a --- b'), 'a-b');
});

test('renderParagraphs splits on blank lines and wraps in <p>', () => {
  assert.equal(renderParagraphs('one\n\ntwo'), '<p>one</p><p>two</p>');
});

test('renderParagraphs escapes html and converts inner newlines to <br>', () => {
  assert.equal(renderParagraphs('a<b\nc'), '<p>a&lt;b<br>c</p>');
});

test('renderParagraphs ignores extra blank lines and trailing whitespace', () => {
  assert.equal(renderParagraphs('one\n\n\n\ntwo\n'), '<p>one</p><p>two</p>');
});

test('formatPostDate renders long month day year', () => {
  assert.equal(formatPostDate('2026-07-09T00:30:00Z'), 'July 9, 2026');
});

test('renderParagraphs turns an image line into a figure with caption', () => {
  assert.equal(
    renderParagraphs('one\n\n![a beach](https://x.co/a.jpg)\n\ntwo'),
    '<p>one</p><figure><img src="https://x.co/a.jpg" alt="a beach" loading="lazy"><figcaption>a beach</figcaption></figure><p>two</p>'
  );
});

test('renderParagraphs leaves non-https image lines as escaped text', () => {
  assert.equal(renderParagraphs('![x](javascript:alert(1))'), '<p>![x](javascript:alert(1))</p>');
});

test('toPlainText swaps images for [image: url] placeholders', () => {
  assert.equal(toPlainText('one\n\n![c](https://x.co/a.jpg)'), 'one\n\n[image: https://x.co/a.jpg]');
});

const { renderPostPage } = require('../api/_render-post.js');
const fs = require('node:fs');

test('renderPostPage fills the real template with title, body, og tags and slug', () => {
  const tpl = fs.readFileSync(require('node:path').join(__dirname, '..', 'p', 'index.html'), 'utf8');
  const html = renderPostPage(tpl, {
    slug: 'hi', title: 'Hi <b>', created_at: '2026-07-09T00:30:00Z',
    body: 'hello\n\n![c](https://x.co/a.jpg)'
  }, 'https://site.test');
  assert.match(html, /<title>Hi &lt;b&gt; - Taproot's Blog<\/title>/);
  assert.match(html, /<p>hello<\/p><figure><img src="https:\/\/x\.co\/a\.jpg"/);
  assert.match(html, /og:image" content="https:\/\/x\.co\/a\.jpg"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /data-slug="hi"/);
  assert.match(html, /<div id="post-date" class="article-date">July 9, 2026</);
  assert.ok(!html.includes('post-page.js'));
});

test('renderPostPage throws when the template changes shape', () => {
  assert.throws(() => renderPostPage('<html></html>', { slug: 'a', title: 't', body: 'b', created_at: '2026-01-01T00:00:00Z' }, 'https://s.t'));
});
