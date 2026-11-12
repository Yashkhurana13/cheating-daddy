const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { redactForLog, pruneTransportLogs } = require('../src/utils/transportLogger');

assert.equal(typeof redactForLog, 'function', 'The logger must export its redaction helper');
assert.equal(typeof pruneTransportLogs, 'function', 'The logger must export its pruning helper');

const audio = 'A'.repeat(10000);
const message = {
    serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio } }, { text: 'Hello' }] },
        outputTranscription: { text: 'Hello' },
    },
};
const original = JSON.parse(JSON.stringify(message));
const redacted = redactForLog(message);
assert.equal(redacted.serverContent.modelTurn.parts[0].inlineData.data, '[base64 7500 bytes]');
assert.deepEqual(message, original, 'Redaction must not mutate the Live message');
assert.notEqual(redacted, message);
assert.notEqual(redacted.serverContent.modelTurn.parts, message.serverContent.modelTurn.parts);
redacted.serverContent.modelTurn.parts[1].text = 'Changed copy';
assert.equal(message.serverContent.modelTurn.parts[1].text, 'Hello', 'Unredacted objects must also be copied');

assert.deepEqual(redactForLog({ apiKey: 'sk-123', headers: { Authorization: 'Bearer x' } }), {
    apiKey: 'REDACTED',
    headers: { Authorization: 'REDACTED' },
});
assert.deepEqual(redactForLog([{ APIKEY: 'secret', KeY: 'secret', ToKeN: 'secret', authorization: 'secret' }]), [
    { APIKEY: 'REDACTED', KeY: 'REDACTED', ToKeN: 'REDACTED', authorization: 'REDACTED' },
]);
assert.deepEqual(redactForLog({ image: { mimeType: 'image/png', data: 'aGVsbG8=' }, audio: { data: 'AAAA' } }), {
    image: { mimeType: 'image/png', data: '[base64 5 bytes]' },
    audio: { data: '[base64 3 bytes]' },
});
assert.deepEqual(redactForLog({ data: 'ordinary text with spaces', values: [null, false, 42, 'text'] }), {
    data: 'ordinary text with spaces',
    values: [null, false, 42, 'text'],
});
assert.equal(redactForLog(undefined), undefined);

const logsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-logger-'));
try {
    const oldPath = path.join(logsDirectory, 'old.json');
    const freshPath = path.join(logsDirectory, 'fresh.json');
    const now = Date.now();
    const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1000);
    fs.writeFileSync(oldPath, '[]');
    fs.utimesSync(oldPath, oldTime, oldTime);
    fs.writeFileSync(freshPath, '[]');
    const directoryPath = path.join(logsDirectory, 'keep-directory');
    fs.mkdirSync(directoryPath);
    fs.utimesSync(directoryPath, oldTime, oldTime);

    pruneTransportLogs(logsDirectory);
    assert.equal(fs.existsSync(oldPath), false, 'Logs older than seven days must be deleted');
    assert.equal(fs.existsSync(freshPath), true, 'Fresh logs must be retained');
    assert.equal(fs.existsSync(directoryPath), true, 'Pruning must only delete files');
    assert.doesNotThrow(() => pruneTransportLogs(path.join(logsDirectory, 'missing')));
    assert.doesNotThrow(() => pruneTransportLogs(freshPath), 'Directory read failures must not escape');

    // Pruning failures must never interrupt a session.
    fs.writeFileSync(oldPath, '[]');
    fs.utimesSync(oldPath, oldTime, oldTime);
    const originalUnlink = fs.unlinkSync;
    try {
        fs.unlinkSync = () => {
            throw new Error('Deletion unavailable');
        };
        assert.doesNotThrow(() => pruneTransportLogs(logsDirectory), 'Deletion failures must not escape');
    } finally {
        fs.unlinkSync = originalUnlink;
    }

    // A child process exits after the real write stream flushes and closes.
    execFileSync(
        process.execPath,
        [
            '-e',
            `const logger = require(process.argv[1]);
             logger.startTransportLog('test-session', process.argv[2]);
             logger.logTransportEvent('gemini.live.message', JSON.parse(process.argv[3]));
             logger.logTransportEvent('credentials', { apiKey: 'sk-123', headers: { Authorization: 'Bearer x' } });
             logger.closeTransportLog();`,
            require.resolve('../src/utils/transportLogger'),
            logsDirectory,
            JSON.stringify(message),
        ],
        { encoding: 'utf8' }
    );
    assert.equal(fs.existsSync(oldPath), false, 'Opening a log must prune expired files');
    assert.equal(fs.existsSync(freshPath), true);
    const loggedText = fs.readFileSync(path.join(logsDirectory, 'test-session.json'), 'utf8');
    const events = JSON.parse(loggedText);
    assert.equal(events[1].data.serverContent.modelTurn.parts[0].inlineData.data, '[base64 7500 bytes]');
    assert.equal(events[2].data.apiKey, 'REDACTED');
    assert.equal(events[2].data.headers.Authorization, 'REDACTED');
    for (const secret of [audio, 'sk-123', 'Bearer x']) {
        assert.equal(loggedText.includes(secret), false, 'Raw media and credentials must never reach disk');
    }
} finally {
    fs.rmSync(logsDirectory, { recursive: true, force: true });
}

const cloudSource = fs.readFileSync(path.join(__dirname, '../src/utils/cloud.js'), 'utf8');
assert.equal(/console\.log\([^;]*,\s*url\s*\)/.test(cloudSource), false, 'Cloud must not log the raw connection URL');
assert.equal(cloudSource.includes('REDACTED'), true, 'The logged cloud token must be redacted');
const geminiSource = fs.readFileSync(path.join(__dirname, '../src/utils/gemini.js'), 'utf8');
assert.equal(geminiSource.includes("console.log('----------------', message)"), false, 'Live messages must not be dumped to the console');

console.log('transportLogger tests passed');
