const assert = require('node:assert/strict');
const { createStartGuard, stopAllMedia } = require('../src/utils/captureLifecycle');

async function testCleanup() {
    const stops = [0, 0, 0];
    const closes = [0, 0];
    const finishClosing = [];
    const tracks = stops.map((_, index) => ({ stop: () => stops[index]++ }));
    const screen = { getTracks: () => tracks.slice(0, 2) };
    const mic = { getTracks: () => [tracks[2]] };
    const contexts = closes.map((_, index) => ({
        close() {
            return new Promise(resolve => {
                finishClosing.push(() => {
                    closes[index]++;
                    resolve();
                });
            });
        },
    }));
    const media = { streams: [screen, mic, screen, null], contexts: [...contexts, contexts[0], null] };

    let cleanupFinished = false;
    const cleanup = stopAllMedia(media).then(() => (cleanupFinished = true));
    await Promise.resolve();
    assert.equal(cleanupFinished, false, 'Cleanup must wait for asynchronous context closes');
    const repeatedCleanup = stopAllMedia(media);
    assert.equal(finishClosing.length, 2);
    finishClosing.forEach(finish => finish());
    await Promise.all([cleanup, repeatedCleanup]);
    await stopAllMedia(media);
    await stopAllMedia({ streams: [], contexts: [] });
    assert.deepEqual(stops, [1, 1, 1], 'Every screen, system audio and mic track must stop exactly once');
    assert.deepEqual(closes, [1, 1], 'Cleanup must await both contexts and close each exactly once');
}

async function testCleanupErrors() {
    const closeError = new Error('Context close failed');
    let stopped = false;
    let closed = false;
    const errors = await stopAllMedia({
        streams: [{ getTracks: () => [{ stop: () => (stopped = true) }] }],
        contexts: [
            {
                close: async () => {
                    throw closeError;
                },
            },
            { close: async () => (closed = true) },
        ],
    });
    assert.equal(stopped, true);
    assert.equal(closed, true, 'A failed close must not prevent other contexts from closing');
    assert.deepEqual(errors, [closeError]);
}

async function testStartGuard() {
    const runStart = createStartGuard();
    let release;
    const pending = new Promise(resolve => (release = resolve));
    let starts = 0;
    const first = runStart(async () => {
        starts++;
        await pending;
        return true;
    });
    const second = runStart(async () => starts++);
    await second;
    assert.equal(starts, 1, 'Concurrent starts must run only once');
    release();
    assert.equal(await first, true);

    const failure = new Error('Initialization failed');
    await assert.rejects(
        runStart(async () => {
            throw failure;
        }),
        error => error === failure
    );
    assert.equal(await runStart(async () => 'retry succeeded'), 'retry succeeded', 'A failed start must release the guard');
    await assert.rejects(
        runStart(() => {
            throw failure;
        }),
        error => error === failure
    );
    assert.equal(await runStart(() => 'retry after synchronous failure'), 'retry after synchronous failure');
}

async function main() {
    await testCleanup();
    await testCleanupErrors();
    await testStartGuard();
    console.log('Capture lifecycle tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
