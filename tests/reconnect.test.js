const assert = require('node:assert/strict');
const loadAiModule = require('./loadAiModule');

function fixture() {
    const pendingDelays = [];
    const connections = [];
    const events = [];
    let failures = 0;
    let logsClosed = 0;
    let closeDuringContext = false;
    const { api, handlers } = loadAiModule(
        'gemini.js',
        {
            electron: {
                BrowserWindow: {
                    getAllWindows: () => [{ webContents: { send: (...args) => events.push(args), executeJavaScript: async () => 'false' } }],
                },
                ipcMain: { handle: (name, handler) => (handlers[name] = handler) },
            },
            '@google/genai': {
                Modality: { AUDIO: 'audio' },
                GoogleGenAI: class {
                    live = {
                        connect: async ({ callbacks }) => {
                            if (failures > 0) {
                                failures--;
                                throw new Error('offline');
                            }
                            const session = {
                                close: async () => callbacks.onclose({ reason: 'user closed' }),
                                sendRealtimeInput: async () => {
                                    if (closeDuringContext) {
                                        closeDuringContext = false;
                                        callbacks.onclose({ reason: 'closed during context restoration' });
                                    }
                                },
                            };
                            connections.push({ callbacks, session });
                            return session;
                        },
                    };
                },
            },
            '../storage': {
                getConfig: () => ({ geminiLiveModel: 'test' }),
                getGroqApiKey: () => '',
                getPreferences: () => ({ audioMode: 'speaker_only' }),
            },
            './transportLogger': { startTransportLog() {}, logTransportEvent() {}, closeTransportLog: () => logsClosed++ },
        },
        {
            setTimeout: (callback, delay) => {
                if (delay === 2000) pendingDelays.push(callback);
                else callback();
            },
        }
    );
    const ref = { current: null };
    api.setupGeminiIpcHandlers(ref);
    return {
        api,
        handlers,
        ref,
        pendingDelays,
        connections,
        events,
        fail: count => (failures = count),
        closedLogs: () => logsClosed,
        closeDuringContext: () => (closeDuringContext = true),
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function reconnect(f) {
    f.connections.at(-1).callbacks.onclose({ reason: 'server timeout' });
    assert.equal(f.pendingDelays.length, 1);
    f.pendingDelays.shift()();
    await tick();
}

async function main() {
    const f = fixture();
    assert.equal(await f.handlers['initialize-gemini'](null, 'key'), true);
    for (let i = 0; i < 5; i++) await reconnect(f);
    assert.equal(f.connections.length, 6, 'Successful reconnects reset the consecutive failure budget');
    assert.equal(
        f.events.some(([name]) => name === 'reconnect-failed'),
        false
    );

    f.connections.at(-1).callbacks.onclose({ reason: 'timeout' });
    await f.handlers['close-session']();
    f.pendingDelays.shift()();
    await tick();
    assert.equal(f.connections.length, 6, 'Closing during the reconnect delay must prevent a new connection');
    assert.equal(f.ref.current, null);
    assert.equal(await f.handlers['initialize-gemini'](null, 'key'), true);
    await reconnect(f);
    assert.equal(f.connections.length, 8, 'A fresh session clears the user-closing flag');

    f.connections.at(-1).callbacks.onclose({ reason: 'timeout' });
    await f.handlers['close-session']();
    assert.equal(await f.handlers['initialize-gemini'](null, 'new-key'), true);
    f.pendingDelays.shift()();
    await tick();
    assert.equal(f.connections.length, 9, 'A stale delay cannot reconnect into a newly opened session');

    await f.handlers['start-new-session']();
    await reconnect(f);
    assert.equal(f.connections.length, 10, 'Resetting conversation history preserves the live connection callbacks');

    f.fail(3);
    f.connections.at(-1).callbacks.onclose({ reason: 'timeout' });
    for (let i = 0; i < 3; i++) {
        f.pendingDelays.shift()();
        await tick();
    }
    assert.equal(f.events.filter(([name]) => name === 'reconnect-failed').length, 1);
    assert.equal(
        f.events.some(([name, data]) => name === 'update-status' && /failed/i.test(data)),
        true,
        'Exhaustion gives a clear status'
    );
    assert.ok(f.closedLogs() >= 2, 'Exhaustion closes the transport log');
    const duringContext = fixture();
    await duringContext.handlers['initialize-gemini'](null, 'key');
    duringContext.api.saveConversationTurn('question', 'answer');
    duringContext.closeDuringContext();
    await reconnect(duringContext);
    assert.equal(duringContext.pendingDelays.length, 1, 'A connection closing during context restoration must still retry');
    duringContext.pendingDelays.shift()();
    await tick();
    assert.equal(duringContext.connections.length, 3);
    await duringContext.handlers['close-session']();
    console.log('reconnect tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
