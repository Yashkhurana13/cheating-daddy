const assert = require('node:assert/strict');
const { createAudioMixer } = require('../src/utils/audioMixer');
const loadAiModule = require('./loadAiModule');

function pcm(samples) {
    const result = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2));
    return result;
}

function samples(buffer) {
    return Array.from({ length: buffer.length / 2 }, (_, index) => buffer.readInt16LE(index * 2));
}

async function main() {
    const output = [];
    const mixer = createAudioMixer(chunk => output.push(chunk), { timeoutMs: 20 });
    mixer.push('system', pcm([30000, -30000, 100, 400]));
    assert.equal(output.length, 0, 'Wait for the matching stream');
    mixer.push('mic', pcm([10000, -10000]));
    assert.deepEqual(samples(output[0]), [32767, -32768]);
    mixer.push('mic', pcm([200, -100]));
    assert.deepEqual(
        output.map(samples),
        [
            [32767, -32768],
            [300, 300],
        ],
        'Mix sample-aligned data across unequal chunk sizes'
    );
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(output.length, 2, 'Paired chunks are never emitted again as interleaved originals');
    mixer.push('mic', pcm([123, -456]));
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.deepEqual(samples(output[2]), [123, -456], 'A single source passes through after the timeout');
    mixer.push('system', pcm([700]));
    mixer.close();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(output.length, 3, 'Closing discards queued audio and cancels its timer');

    const liveAudio = [];
    let audioMode = 'both';
    const { api, handlers } = loadAiModule('gemini.js', {
        '@google/genai': {
            Modality: { AUDIO: 'audio' },
            GoogleGenAI: class {
                live = { connect: async () => ({ close: async () => {}, sendRealtimeInput: async input => liveAudio.push(input.audio) }) };
            },
        },
        '../storage': {
            getConfig: () => ({ geminiLiveModel: 'test' }),
            getGroqApiKey: () => '',
            getPreferences: () => ({ audioMode }),
        },
    });
    api.setupGeminiIpcHandlers({ current: null });
    await handlers['initialize-gemini'](null, 'key');
    const systemAudio = { data: pcm([1000, -2000]).toString('base64'), mimeType: 'audio/pcm;rate=24000' };
    const micAudio = { data: pcm([2000, -3000]).toString('base64'), mimeType: 'audio/pcm;rate=24000' };
    await handlers['send-audio-content'](null, systemAudio);
    assert.equal(liveAudio.length, 0);
    await handlers['send-mic-audio-content'](null, micAudio);
    assert.equal(liveAudio.length, 1, 'The two IPC channels send one mixed chunk');
    assert.deepEqual(samples(Buffer.from(liveAudio[0].data, 'base64')), [3000, -5000]);
    await handlers['send-audio-content'](null, systemAudio);
    await handlers['close-session']();

    for (const mode of ['speaker_only', 'mic_only']) {
        audioMode = mode;
        await handlers['initialize-gemini'](null, 'key');
        const before = liveAudio.length;
        const channel = mode === 'mic_only' ? 'send-mic-audio-content' : 'send-audio-content';
        await handlers[channel](null, micAudio);
        assert.equal(liveAudio.length, before + 1, 'Single-source modes send immediately');
        assert.equal(liveAudio.at(-1).data, micAudio.data);
        assert.equal(liveAudio.at(-1).mimeType, micAudio.mimeType);
        await handlers['close-session']();
    }
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(liveAudio.length, 3, 'Queued audio cannot leak from a closed session');
    console.log('audioMixer tests passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
