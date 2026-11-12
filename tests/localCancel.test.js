const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadAiModule = require('./loadAiModule');

async function main() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-cancel-'));
    try {
        const modelPath = path.join(directory, 'model.gguf');
        fs.writeFileSync(modelPath, Buffer.alloc(1024 * 1024, 42));
        const checksum = crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex');
        let onRead = () => {};
        let lastStream;
        const { api: runtime } = loadAiModule('native-ai-runtime.js', {
            fs: {
                ...fs,
                createReadStream: (filePath, options) => {
                    lastStream = fs.createReadStream(filePath, { ...options, highWaterMark: 1024 });
                    lastStream.once('data', () => onRead());
                    return lastStream;
                },
            },
        });
        assert.equal(typeof runtime.fileMatchesChecksum, 'function', 'Checksum verification must be callable from Node');
        const controller = new AbortController();
        onRead = () => controller.abort();
        await assert.rejects(runtime.fileMatchesChecksum(modelPath, checksum, controller.signal), { name: 'AbortError' });
        assert.equal(lastStream.destroyed, true, 'Cancellation destroys the hashing stream');
        onRead = () => {};
        assert.equal(await runtime.fileMatchesChecksum(modelPath, checksum), true);
        assert.equal(await runtime.fileMatchesChecksum(modelPath, 'wrong'), false);
        await assert.rejects(runtime.fileMatchesChecksum(modelPath, checksum, controller.signal), { name: 'AbortError' });

        let spawned = 0;
        const { api: local } = loadAiModule('localai.js', {
            './gemini': { sendToRenderer() {}, initializeNewSession() {}, saveConversationTurn() {} },
            './native-ai-runtime': {
                getModelsDirectory: () => directory,
                ensureNativeBinary: async () => modelPath,
                ensureWhisperModel: async () => modelPath,
                ensureLlamaModel: async (model, progress, visionProgress, signal) => {
                    await runtime.fileMatchesChecksum(modelPath, checksum, signal);
                    return { modelPath, projectorPath: modelPath };
                },
                getAvailablePort: async () => 1234,
                startNativeServer: () => {
                    spawned++;
                    return { exitCode: null };
                },
                stopNativeServer() {},
                waitForServer: async () => {},
            },
        });
        onRead = () => {
            void local.cancelLocalInitialization();
        };
        assert.equal(await local.initializeLocalSession('test:model', 'tiny.en', 'interview', ''), false);
        assert.equal(spawned, 0, 'Cancelling during language-model hashing must never spawn a server');
        assert.equal(local.isLocalSessionActive(), false);

        let releaseOldPreparation;
        const oldPreparation = new Promise(resolve => (releaseOldPreparation = resolve));
        const servers = [];
        let readiness = null;
        const { api: overlapping } = loadAiModule('localai.js', {
            './gemini': { sendToRenderer() {}, initializeNewSession() {}, saveConversationTurn() {} },
            './native-ai-runtime': {
                getModelsDirectory: () => directory,
                ensureNativeBinary: async () => modelPath,
                ensureWhisperModel: async () => modelPath,
                ensureLlamaModel: async model => {
                    if (model === 'old:model') await oldPreparation;
                    return { modelPath, projectorPath: modelPath };
                },
                getAvailablePort: async () => 1234,
                startNativeServer: () => {
                    const child = { exitCode: null, stopped: false };
                    servers.push(child);
                    return child;
                },
                stopNativeServer: child => {
                    if (child) child.stopped = true;
                },
                waitForServer: async () => {
                    if (readiness) {
                        const pending = readiness;
                        readiness = null;
                        await pending;
                    }
                },
            },
        });
        const oldRun = overlapping.initializeLocalSession('old:model', 'tiny.en', 'interview', '');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(await overlapping.initializeLocalSession('new:model', 'tiny.en', 'interview', ''), true);
        releaseOldPreparation();
        assert.equal(await oldRun, false, 'Superseded preparation cannot activate an old session');
        assert.equal(servers.length, 2, 'Only the current initialization spawns servers');
        assert.equal(
            servers.some(child => child.stopped),
            false,
            'Old-run cleanup cannot stop the new session servers'
        );
        assert.equal(overlapping.isLocalSessionActive(), true);
        overlapping.closeLocalSession();
        assert.equal(
            servers.every(child => child.stopped),
            true
        );
        servers.length = 0;
        let releaseReadiness;
        readiness = new Promise(resolve => (releaseReadiness = resolve));
        const waitingRun = overlapping.initializeLocalSession('waiting:model', 'tiny.en', 'interview', '');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(servers.length, 1, 'Whisper has started, while Llama is still pending');
        assert.equal(await overlapping.cancelLocalInitialization(), true);
        assert.equal(servers[0].stopped, true, 'Aborting immediately stops an already spawned server');
        releaseReadiness();
        assert.equal(await waitingRun, false);
        assert.equal(servers.length, 1, 'A cancelled server readiness step cannot start Llama');
        assert.equal(overlapping.isLocalSessionActive(), false);
        console.log('localCancel tests passed');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
