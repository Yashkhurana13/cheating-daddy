function isSafeExternalUrl(url) {
    if (typeof url !== 'string') {
        return false;
    }

    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

module.exports = { isSafeExternalUrl };
