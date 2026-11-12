const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Inject native/network dependencies while running the actual main-process code in Node.
module.exports = function loadAiModule(filename, dependencies = {}, globals = {}) {
    const filePath = path.resolve(__dirname, '../src/utils', filename);
    const realRequire = createRequire(filePath);
    const handlers = {};
    const defaults = {
        electron: { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: (name, handler) => (handlers[name] = handler) } },
        '@google/genai': { GoogleGenAI: class {}, Modality: { AUDIO: 'audio' } },
        './cloud': {},
        './transportLogger': { startTransportLog() {}, logTransportEvent() {}, closeTransportLog() {} },
    };
    const module = { exports: {} };
    const context = {
        module,
        exports: module.exports,
        require: name =>
            Object.hasOwn(dependencies, name) ? dependencies[name] : Object.hasOwn(defaults, name) ? defaults[name] : realRequire(name),
        __dirname: path.dirname(filePath),
        Buffer,
        TextDecoder,
        AbortController,
        setTimeout,
        clearTimeout,
        console: { log() {}, warn() {}, error() {} },
        process: { platform: process.platform, arch: process.arch, env: {}, stdout: { write() {} } },
        global: {},
        ...globals,
    };
    vm.runInNewContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
    return { api: module.exports, handlers, context };
};
