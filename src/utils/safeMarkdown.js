(function () {
    function escapeHtml(content) {
        return String(content).replace(/[&<>"']/g, character => {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
        });
    }

    function isSafeUrl(href, allowRelative) {
        if (typeof href !== 'string') return false;
        const url = href.trim();
        // Reject browser-ignored controls and backslashes before classifying the scheme.
        if (/[\u0000-\u001f\u007f-\u009f\\]/.test(url)) return false;
        if (/^(https?:|mailto:)/i.test(url)) return true;
        if (!allowRelative || url.startsWith('//')) return false;

        // A relative URL's first segment cannot contain a scheme or an HTML entity
        // that could disguise one. Decode percent escapes for this check only.
        try {
            const firstSegment = decodeURIComponent(url.split(/[/?#]/, 1)[0]);
            return !/[:&\\]/.test(firstSegment);
        } catch {
            return false;
        }
    }

    // Sanitize descendants of a body/fragment without relying on DOM globals.
    function sanitizeDom(rootNode) {
        const allowedTags = new Set(
            'p br hr h1 h2 h3 h4 h5 h6 strong em b i del s code pre blockquote ul ol li a img table thead tbody tr th td span div'.split(' ')
        );
        const allowedAttributes = {
            code: ['class'],
            pre: ['class'],
            span: ['class'],
            a: ['href', 'title'],
            img: ['src', 'alt', 'title'],
            th: ['align'],
            td: ['align'],
            ol: ['start'],
        };

        function sanitizeChildren(parent) {
            for (const node of Array.from(parent.childNodes)) {
                if (node.nodeType !== 1) continue;
                const tag = node.tagName.toLowerCase();
                if (!allowedTags.has(tag)) {
                    node.remove();
                    continue;
                }
                for (const { name, value } of Array.from(node.attributes)) {
                    if (
                        !(allowedAttributes[tag] || []).includes(name) ||
                        (tag === 'a' && name === 'href' && !isSafeUrl(value, true)) ||
                        (tag === 'img' && name === 'src' && !isSafeUrl(value, false))
                    ) {
                        node.removeAttribute(name);
                    }
                }
                sanitizeChildren(node);
            }
        }

        sanitizeChildren(rootNode);
        return rootNode;
    }

    function renderSafeMarkdown(content, marked) {
        try {
            if (!marked) return escapeHtml(content);
            const renderer = new marked.Renderer();
            const tokenizer = new marked.Tokenizer();
            const tokenizeInlineText = tokenizer.inlineText.bind(tokenizer);
            const renderLink = renderer.link.bind(renderer);
            const renderImage = renderer.image.bind(renderer);

            // Raw HTML uses renderer.html, but marked 4.x skips escaping inline
            // text after tags like <code>. Other inline tokens (including
            // codespans and autolinks) already escape text or recurse here.
            tokenizer.inlineText = (...args) => {
                const token = tokenizeInlineText(...args);
                if (token && tokenizer.lexer.state.inRawBlock) token.text = escapeHtml(token.raw);
                return token;
            };
            renderer.html = escapeHtml;
            renderer.link = (href, title, text) => (isSafeUrl(href, true) ? renderLink(href.trim(), title, text) : text);
            renderer.image = (href, title, text) => (isSafeUrl(href, false) ? renderImage(href.trim(), title, text) : text);

            // Keep marked's normal code escaping and language classes. Do not
            // mutate global marked options or escape the markdown before parsing.
            return marked.parse(content, { breaks: true, gfm: true, renderer, tokenizer });
        } catch {
            return escapeHtml(content);
        }
    }

    const safeMarkdown = { escapeHtml, renderSafeMarkdown, sanitizeDom };
    if (typeof module !== 'undefined' && module.exports) module.exports = safeMarkdown;
    if (typeof window !== 'undefined') window.safeMarkdown = safeMarkdown;
})();
