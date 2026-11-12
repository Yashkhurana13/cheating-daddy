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

    function renderSafeMarkdown(content, marked) {
        try {
            if (!marked) return escapeHtml(content);
            const renderer = new marked.Renderer();
            const renderLink = renderer.link.bind(renderer);
            const renderImage = renderer.image.bind(renderer);

            // Marked 4.x routes both block and inline raw HTML through this hook.
            renderer.html = escapeHtml;
            renderer.link = (href, title, text) => (isSafeUrl(href, true) ? renderLink(href.trim(), title, text) : text);
            renderer.image = (href, title, text) => (isSafeUrl(href, false) ? renderImage(href.trim(), title, text) : text);

            // Keep marked's normal code escaping and language classes. Do not
            // mutate global marked options or escape the markdown before parsing.
            return marked.parse(content, { breaks: true, gfm: true, renderer });
        } catch {
            return escapeHtml(content);
        }
    }

    const safeMarkdown = { escapeHtml, renderSafeMarkdown };
    if (typeof module !== 'undefined' && module.exports) module.exports = safeMarkdown;
    if (typeof window !== 'undefined') window.safeMarkdown = safeMarkdown;
})();
