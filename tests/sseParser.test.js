const assert = require('node:assert/strict');
const loadAiModule = require('./loadAiModule');
const { api } = loadAiModule('gemini.js');

async function main() {
    assert.equal(typeof api.splitSseLines, 'function', 'Export the pure line splitter');
    const result = api.splitSseLines('data: {"a":', '1}\r\ndata: [DO');
    assert.deepEqual(Array.from(result.lines), ['data: {"a":1}']);
    assert.equal(result.pendingText, 'data: [DO');

    const chunks = ['data: {"choices":[{"del', 'ta":{"content":"hé', 'llo"}}]}\r\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\ndata: [DO', 'NE]'];
    const encoded = Buffer.from(chunks.join(''));
    const accentIndex = encoded.indexOf(Buffer.from('é'));
    // Also split inside a UTF-8 code point, and flush an unterminated final event.
    const byteChunks = [encoded.subarray(0, 12), encoded.subarray(12, accentIndex + 1), encoded.subarray(accentIndex + 1)];
    const events = [];
    for await (const data of api.readSseData(
        (async function* () {
            yield* byteChunks;
        })()
    ))
        events.push(JSON.parse(data));
    assert.deepEqual(events, [{ choices: [{ delta: { content: 'héllo' } }] }, { choices: [{ delta: { content: '!' } }] }]);

    const stopped = [];
    for await (const data of api.readSseData(
        (async function* () {
            yield Buffer.from('data: [DONE]\ndata: {"ignored":true}\n');
        })()
    ))
        stopped.push(data);
    assert.deepEqual(stopped, [], '[DONE] terminates parsing');
    const remainder = [];
    for await (const data of api.readSseData(
        (async function* () {
            yield Buffer.from('data: {"last":true}');
        })()
    ))
        remainder.push(data);
    assert.deepEqual(remainder, ['{"last":true}']);
    console.log('sseParser tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
