const assert = require('node:assert/strict');
const marked = require('../src/assets/marked-4.3.0.min.js');
const { renderSafeMarkdown, sanitizeDom } = require('../src/utils/safeMarkdown.js');
const render = content => renderSafeMarkdown(content, marked);

const imageHtml = render('<img src=x onerror="alert(1)">');
assert.doesNotMatch(imageHtml, /<img\b/i);
assert.doesNotMatch(imageHtml, /<[^>]*\bonerror\s*=/i);
assert.match(imageHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
assert.match(render('<script>alert(1)</script>'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(render('before <b onclick="alert(1)">after</b>'), /&lt;b onclick=&quot;alert\(1\)&quot;&gt;after&lt;\/b&gt;/);

// Raw-block state must never let inline text bypass HTML escaping.
for (const tag of ['code', 'pre', 'textarea', 'kbd', 'script']) {
    for (const payload of [
        '<img/src=x onerror="globalThis.__p=1">',
        '<svg/x onload="globalThis.__p=1">',
        '<svg onload="globalThis.__p=1">',
        '<img onerror="globalThis.__p=1">',
    ]) {
        for (const content of [
            `<${tag}>${payload}`,
            `a <${tag}>${payload}`,
            `a <${tag}>\`${payload}\``,
            `a <${tag}>**${payload}**`,
            `a <${tag}>*${payload}*`,
            `a <${tag}>~~${payload}~~`,
            `a <${tag}>[${payload}](https://example.com)`,
            `a <${tag}>[${payload}][missing]`,
        ]) {
            const html = render(content);
            assert.doesNotMatch(html, /<[a-z][^>]*\son\w+\s*=/i, content);
            assert.doesNotMatch(html, /<(?:img|svg)\b/i, content);
        }
    }
}

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
assert.match(render('one &amp; two & three < four'), /one &amp; two &amp; three &lt; four/);

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
        Tokenizer: marked.Tokenizer,
        parse() {
            throw new Error('Parser failure');
        },
    }),
    escaped
);

// Node has no DOMParser. Keep just the DOM operations used by sanitizeDom.
function element(tagName, attributes = {}, childNodes = []) {
    const node = {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
        childNodes,
        removeAttribute(name) {
            this.attributes.splice(
                this.attributes.findIndex(attribute => attribute.name === name),
                1
            );
        },
        remove() {
            this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
            this.parentNode = null;
        },
    };
    childNodes.forEach(child => (child.parentNode = node));
    return node;
}
const attributesOf = node => Object.fromEntries(node.attributes.map(({ name, value }) => [name, value]));

const text = { nodeType: 3, textContent: '<img onerror="evil()">' };
const codeNode = element('code', { class: 'language-js', onclick: 'evil()', style: 'color:red' }, [text]);
const preNode = element('pre', { class: 'highlight', onmouseover: 'evil()' }, [codeNode]);
const linkNode = element('a', { href: '/guide', title: 'Guide', target: '_blank', onclick: 'evil()' });
const imageNode = element('img', { src: 'https://example.com/a.png', alt: 'A', title: 'Image', onerror: 'evil()', srcset: 'evil' });
const cellNode = element('td', { align: 'right', style: 'color:red', onclick: 'evil()' });
const tableNode = element('table', { class: 'evil' }, [element('tbody', {}, [element('tr', {}, [cellNode])])]);
const listNode = element('ol', { start: '3', reversed: '', onclick: 'evil()' });
const spanNode = element('span', { class: 'response-word', 'data-word': '', onanimationstart: 'evil()' });
const paragraphNode = element('p', { class: 'evil', id: 'evil', title: 'evil', href: 'https://example.com' }, [spanNode]);
const removedNodes = ['script', 'svg', 'iframe', 'object', 'textarea', 'input', 'style', 'math', 'template'].map(tag =>
    element(tag, { onload: 'evil()' }, [element('img', { onerror: 'evil()' })])
);
const root = element('body', {}, [...removedNodes, preNode, linkNode, imageNode, tableNode, listNode, paragraphNode]);
sanitizeDom(root);
assert.deepEqual(root.childNodes, [preNode, linkNode, imageNode, tableNode, listNode, paragraphNode]);
assert.deepEqual(attributesOf(preNode), { class: 'highlight' });
assert.deepEqual(attributesOf(codeNode), { class: 'language-js' });
assert.equal(codeNode.childNodes[0].textContent, '<img onerror="evil()">');
assert.deepEqual(attributesOf(linkNode), { href: '/guide', title: 'Guide' });
assert.deepEqual(attributesOf(imageNode), { src: 'https://example.com/a.png', alt: 'A', title: 'Image' });
assert.deepEqual(attributesOf(tableNode), {});
assert.deepEqual(attributesOf(cellNode), { align: 'right' });
assert.deepEqual(attributesOf(listNode), { start: '3' });
assert.deepEqual(attributesOf(spanNode), { class: 'response-word' });
assert.deepEqual(attributesOf(paragraphNode), {});

for (const url of [
    'javascript:evil()',
    'java\tscript:evil()',
    'javascript&colon;evil()',
    'javascript%3Aevil()',
    'data:text/html,evil',
    'file:///tmp/evil',
    '//example.com/evil',
    '\\evil',
]) {
    const link = element('a', { href: url, onclick: 'evil()' });
    const image = element('img', { src: url, onerror: 'evil()' });
    sanitizeDom(element('body', {}, [link, image]));
    assert.deepEqual(attributesOf(link), {}, url);
    assert.deepEqual(attributesOf(image), {}, url);
}
for (const url of [
    'https://example.com',
    'http://example.com',
    'mailto:user@example.com',
    '#section',
    '/guide',
    './guide',
    '../guide',
    'guide',
    '?page=2',
]) {
    const link = element('a', { href: url, title: 'Link' });
    sanitizeDom(element('body', {}, [link]));
    assert.deepEqual(attributesOf(link), { href: url, title: 'Link' });
}
for (const url of ['relative.png', '/image.png', '#image']) {
    const image = element('img', { src: url, alt: 'Image' });
    sanitizeDom(element('body', {}, [image]));
    assert.deepEqual(attributesOf(image), { alt: 'Image' });
}

console.log('safeMarkdown tests passed');
