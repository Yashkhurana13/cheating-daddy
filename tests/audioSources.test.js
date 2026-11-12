const assert = require('node:assert/strict');
const os = require('node:os');
const loadAiModule = require('./loadAiModule');

function tone(value) {
    const buffer = Buffer.alloc(4800);
    for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
    return buffer;
}

async function checkSources(sendAudio, transcriptions) {
    const silence = tone(0);
    for (let i = 0; i < 8; i++) await sendAudio('mic', tone(4000));
    await sendAudio('system', tone(-4000).subarray(0, 2));
    await sendAudio('mic', tone(4000));
    for (let i = 0; i < 40; i++) await sendAudio('system', silence);
    assert.equal(transcriptions.length, 0, 'System silence cannot terminate microphone speech');
    for (let i = 0; i < 8; i++) await sendAudio('system', tone(-4000));
    for (let i = 0; i < 40; i++) await sendAudio('mic', silence);
    assert.equal(transcriptions.length, 1, 'Microphone silence ends only the microphone segment');
    for (let i = 0; i < 40; i++) await sendAudio('system', silence);
    assert.equal(transcriptions.length, 2);
    const buffers = await Promise.all(transcriptions);
    assert.equal(buffers[0].readInt16LE(44), 4000);
    assert.equal(buffers[1].readInt16LE(44), -4000);
    for (let offset = 44; offset < buffers[0].length; offset += 2) {
        assert.ok(buffers[0].readInt16LE(offset) >= 0, 'Microphone resampling never consumes a system sample');
    }
    for (let offset = 44; offset < buffers[1].length; offset += 2) {
        assert.ok(buffers[1].readInt16LE(offset) <= 0, 'System resampling never consumes a microphone sample');
    }
}

async function main() {
    const transcriptions = [];
    const globals = {
        Blob,
        FormData,
        fetch: async (url, { body }) => {
            transcriptions.push(
                body
                    .get('file')
                    .arrayBuffer()
                    .then(data => Buffer.from(data))
            );
            return { ok: true, json: async () => ({ text: '' }) };
        },
    };
    const { api: groq, handlers } = loadAiModule(
        'gemini.js',
        {
            '../storage': { getGroqApiKey: () => 'key', getPreferences: () => ({ audioMode: 'both' }) },
        },
        globals
    );
    groq.setupGeminiIpcHandlers({ current: null });
    await handlers['initialize-gemini'](null, 'key');
    await checkSources(
        (source, buffer) => handlers[source === 'mic' ? 'send-mic-audio-content' : 'send-audio-content'](null, { data: buffer.toString('base64') }),
        transcriptions
    );
    for (let i = 0; i < 8; i++) {
        await handlers['send-mic-audio-content'](null, { data: tone(4000).toString('base64') });
        await handlers['send-audio-content'](null, { data: tone(-4000).toString('base64') });
    }
    await handlers['close-session']();
    await handlers['initialize-gemini'](null, 'key');
    for (let i = 0; i < 40; i++) {
        await handlers['send-mic-audio-content'](null, { data: tone(0).toString('base64') });
        await handlers['send-audio-content'](null, { data: tone(0).toString('base64') });
    }
    assert.equal(transcriptions.length, 2, 'Restarting clears both Groq speech buffers');
    await handlers['close-session']();

    transcriptions.length = 0;
    const { api: local } = loadAiModule(
        'localai.js',
        {
            './gemini': { sendToRenderer() {}, initializeNewSession() {}, saveConversationTurn() {} },
            './native-ai-runtime': {
                getModelsDirectory: () => os.tmpdir(),
                ensureNativeBinary: async () => __filename,
                ensureWhisperModel: async () => __filename,
                ensureLlamaModel: async () => ({ modelPath: __filename, projectorPath: __filename }),
                getAvailablePort: async () => 1234,
                startNativeServer: () => ({ exitCode: null }),
                stopNativeServer() {},
                waitForServer: async () => {},
            },
        },
        globals
    );
    assert.equal(await local.initializeLocalSession('test:model', 'tiny.en', 'interview', ''), true);
    await checkSources((source, buffer) => local.processLocalAudio(buffer, source), transcriptions);
    for (let i = 0; i < 8; i++) {
        local.processLocalAudio(tone(4000), 'mic');
        local.processLocalAudio(tone(-4000), 'system');
    }
    local.closeLocalSession();
    assert.equal(await local.initializeLocalSession('test:model', 'tiny.en', 'interview', ''), true);
    for (let i = 0; i < 40; i++) {
        local.processLocalAudio(tone(0), 'mic');
        local.processLocalAudio(tone(0), 'system');
    }
    assert.equal(transcriptions.length, 2, 'Restarting clears both local speech buffers');
    local.closeLocalSession();
    console.log('audioSources tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
