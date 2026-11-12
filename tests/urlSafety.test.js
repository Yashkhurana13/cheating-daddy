const assert = require('node:assert/strict');
const { isSafeExternalUrl } = require('../src/utils/urlSafety');

for (const url of ['https://example.com', 'http://example.com', 'HTTPS://example.com/path?query=value#fragment']) {
    assert.equal(isSafeExternalUrl(url), true, `Expected safe URL: ${url}`);
}

for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hello',
    'smb://x',
    'myapp://x',
    '',
    null,
    'not a url',
    'https://',
    'http://[invalid]',
    undefined,
    123,
    {},
    { toString: () => 'https://example.com' },
]) {
    assert.equal(isSafeExternalUrl(url), false, `Expected unsafe URL: ${url}`);
}

console.log('URL safety tests passed');
