const assert = require('node:assert/strict');
const marked = require('../src/assets/marked-4.3.0.min.js');
const { renderSafeMarkdown } = require('../src/utils/safeMarkdown.js');
const render = content => renderSafeMarkdown(content, marked);

const imageHtml = render('<img src=x onerror="alert(1)">');
assert.doesNotMatch(imageHtml, /<img\b/i);
assert.doesNotMatch(imageHtml, /<[^>]*\bonerror\s*=/i);
assert.match(imageHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(render('<script>alert(1)</script>'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(render('before <b onclick="alert(1)">after</b>'), /&lt;b onclick=&quot;alert\(1\)&quot;&gt;after&lt;\/b&gt;/);
assert.doesNotMatch(render('[x](javascript:alert(1))'), /<a\b|\bhref\s*=/i);
assert.doesNotMatch(render('[x](JaVaScRiPt:alert(1))'), /<a\b|\bhref\s*=/i);

for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  JaVaScRiPt:alert(1)',
    'java&#x09;script:alert(1)',
    'java&#10;script:alert(1)',
    'javascript&colon;alert(1)',
    '&#106;avascript&#58;alert(1)',
    'java&Tab;script&colon;alert(1)',
    'java\tscript:alert(1)',
    'javascript%3Aalert(1)',
    'data:text/html,evil',
    'file:///tmp/evil',
    'vbscript:evil',
    'custom:evil',
    '//example.com/evil',
]) {
    const link = render(`[x](<${url}>)`);
    assert.doesNotMatch(link, /<a\b|\bhref\s*=/i, url);
    assert.match(link, /x/, url);
    const image = render(`![a](<${url}>)`);
    assert.doesNotMatch(image, /<img\b|\bsrc\s*=/i, url);
    assert.match(image, /a/, url);
}

assert.doesNotMatch(render('![a](data:text/html,...)'), /<img\b|\bsrc\s*=/i);
assert.doesNotMatch(render('![a](relative.png)'), /<img\b|\bsrc\s*=/i);
assert.match(render('[x](https://example.com)'), /<a href="https:\/\/example\.com">x<\/a>/);
assert.match(render('[x](http://example.com)'), /href="http:\/\/example\.com"/);
assert.match(render('[x](mailto:user@example.com)'), /href="mailto:user@example\.com"/);
assert.match(render('![a](https://example.com/a.png)'), /<img src="https:\/\/example\.com\/a\.png" alt="a">/);
for (const url of ['#section', '/guide', './guide', '../guide', 'guide', '?page=2']) {
    assert.ok(render(`[x](${url})`).includes(`href="${url}"`), url);
}

const code = render('```js\nconst x = "<img src=x>";\n```');
assert.match(code, /<pre><code class="language-js">/);
assert.match(code, /&lt;img src=x&gt;/);
assert.doesNotMatch(code, /&amp;lt;|<img\b/);
assert.match(render('`<b>`'), /<code>&lt;b&gt;<\/code>/);

const markdown = render('# Heading\n\n- **bold**\n- item\n\none\ntwo\n\n| A | B |\n| - | - |\n| x | y |');
for (const tag of ['h1', 'ul', 'li', 'strong', 'br', 'table', 'th', 'td']) {
    assert.match(markdown, new RegExp(`<${tag}\\b`), tag);
}

const raw = '<img src=x onerror="alert(1)"> & \'quote\'';
const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quote&#39;';
assert.equal(renderSafeMarkdown(raw, undefined), escaped);
assert.equal(
    renderSafeMarkdown(raw, {
        Renderer: marked.Renderer,
        parse() {
            throw new Error('Parser failure');
        },
    }),
    escaped
);

console.log('safeMarkdown tests passed');
