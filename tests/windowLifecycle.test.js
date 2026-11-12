const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

class FakeBrowserWindow extends EventEmitter {
    static windows = [];

    static getAllWindows() {
        return this.windows.filter(window => !window.isDestroyed());
    }

    constructor() {
        super();
        FakeBrowserWindow.windows.push(this);
        this.destroyed = false;
        this.visible = true;
        this.position = [100, 100];
        this.messages = [];
        this.scripts = [];
        this.webContents = new EventEmitter();
        this.webContents.setWindowOpenHandler = handler => {
            this.openHandler = handler;
        };
        this.webContents.send = (...args) => {
            this.checkAlive();
            this.messages.push(args);
        };
        this.webContents.executeJavaScript = script => {
            this.checkAlive();
            this.scripts.push(script);
            return Promise.resolve();
        };
    }

    checkAlive() {
        assert.equal(this.destroyed, false, 'Object has been destroyed');
    }

    isDestroyed() {
        return this.destroyed;
    }

    close() {
        this.destroyed = true;
        this.emit('closed');
    }

    isVisible() {
        this.checkAlive();
        return this.visible;
    }

    hide() {
        this.checkAlive();
        this.visible = false;
    }

    showInactive() {
        this.checkAlive();
        this.visible = true;
    }

    minimize() {
        this.checkAlive();
        this.minimized = true;
    }

    getPosition() {
        this.checkAlive();
        return this.position;
    }

    setPosition(x, y) {
        this.checkAlive();
        this.position = [x, y];
    }

    setAlwaysOnTop(value) {
        this.checkAlive();
        this.alwaysOnTop = value;
    }

    setVisibleOnAllWorkspaces(value) {
        this.checkAlive();
        this.allWorkspaces = value;
    }

    setIgnoreMouseEvents(value) {
        this.checkAlive();
        this.ignoresMouse = value;
    }

    setContentProtection() {}
    setHiddenInMissionControl() {}
    setSkipTaskbar() {}
    loadFile() {}
}

const ipcMain = new EventEmitter();
const handles = new Map();
const handleCounts = new Map();
ipcMain.handle = (channel, handler) => {
    handleCounts.set(channel, (handleCounts.get(channel) || 0) + 1);
    if (handles.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    handles.set(channel, handler);
};

const shortcuts = new Map();
let registrations = 0;
let unregistrations = 0;
let displayMediaHandler;
let getSources = () => Promise.resolve([{ id: 'screen:0' }]);
let savedKeybinds = null;
let keybindWrites = 0;
const storage = {
    getKeybinds: () => savedKeybinds,
    setKeybinds: keybinds => {
        savedKeybinds = keybinds;
        keybindWrites++;
    },
    initializeStorage() {},
    getPreferences: () => ({}),
};
const app = new EventEmitter();
app.whenReady = () => Promise.resolve();
app.quit = () => {};
const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    globalShortcut: {
        register: (key, callback) => {
            registrations++;
            shortcuts.set(key, callback);
            return true;
        },
        unregisterAll: () => {
            unregistrations++;
            shortcuts.clear();
        },
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1200, height: 800 } }) },
    shell: { openExternal: () => Promise.resolve() },
    desktopCapturer: { getSources: options => getSources(options) },
    session: {
        defaultSession: {
            setDisplayMediaRequestHandler: handler => {
                displayMediaHandler = handler;
            },
            setPermissionRequestHandler() {},
        },
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
};

const originalLoad = Module._load;
const originalSetTimeout = global.setTimeout;
const timers = [];
const sendToRenderer = (...args) => {
    const window = FakeBrowserWindow.getAllWindows()[0];
    if (window) window.webContents.send(...args);
};
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'electron-squirrel-startup') return false;
    if (request === '../storage' || request === './storage') return storage;
    if (request === './utils/gemini') {
        return { sendToRenderer, setupGeminiIpcHandlers() {}, stopMacOSAudioCapture() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};
global.setTimeout = callback => timers.push(callback);
const flushTimers = () => {
    while (timers.length) timers.shift()();
};

async function run() {
    const { createWindow, getDefaultKeybinds } = require('../src/utils/window');
    const sessionRef = { current: null };
    const first = createWindow(sendToRenderer, sessionRef);
    first.webContents.emit('dom-ready');
    flushTimers();
    const firstShortcuts = [...shortcuts.values()];
    assert.ok(firstShortcuts.length > 0, 'The first window should register shortcuts');
    first.destroyed = true;
    for (const callback of firstShortcuts) await callback();
    first.destroyed = false;
    const beforeClose = unregistrations;
    first.close();

    let second;
    assert.doesNotThrow(() => {
        second = createWindow(sendToRenderer, sessionRef);
    }, 'Reopening a window must not register duplicate IPC handlers');
    assert.equal(unregistrations, beforeClose + 1, 'Closing the window must unregister shortcuts');
    assert.equal(shortcuts.size, 0);
    second.webContents.emit('dom-ready');
    flushTimers();
    assert.equal(shortcuts.size, firstShortcuts.length, 'The replacement window must register shortcuts');

    for (const channel of ['hide-window-for-screenshot', 'show-window-after-screenshot', 'window-minimize', 'toggle-window-visibility']) {
        assert.equal(handleCounts.get(channel), 1, `${channel} must be registered once`);
    }
    assert.equal(ipcMain.listenerCount('view-changed'), 1);
    assert.equal(ipcMain.listenerCount('update-keybinds'), 1);
    assert.equal(await handles.get('hide-window-for-screenshot')(), true);
    assert.equal(second.visible, false);
    assert.equal(await handles.get('show-window-after-screenshot')(), true);
    assert.equal(second.visible, true);
    handles.get('window-minimize')();
    assert.equal(second.minimized, true);
    assert.deepEqual(await handles.get('toggle-window-visibility')(), { success: true });
    assert.equal(second.visible, false);
    second.showInactive();
    ipcMain.emit('view-changed', {}, 'assistant');
    if (process.platform !== 'win32') assert.equal(second.alwaysOnTop, true);
    ipcMain.emit('view-changed', {}, 'home');
    assert.equal(second.ignoresMouse, false);

    const keys = getDefaultKeybinds();
    // Even a callback retained from the first registration must target the live window.
    firstShortcuts[0]();
    assert.deepEqual(second.position, [100, 20]);
    shortcuts.get(keys.toggleClickThrough)();
    assert.equal(second.ignoresMouse, true);
    await shortcuts.get(keys.nextStep)();
    assert.equal(second.scripts.length, 1);
    shortcuts.get(keys.nextResponse)();
    assert.deepEqual(second.messages.at(-1), ['navigate-next-response']);

    // Load the real entry point too, so a duplicate keybind listener in index.js is caught.
    second.close();
    require('../src/index');
    await new Promise(resolve => setImmediate(resolve));
    const third = FakeBrowserWindow.getAllWindows()[0];
    assert.equal(ipcMain.listenerCount('update-keybinds'), 1);
    const beforeUpdate = registrations;
    const beforeUpdateUnregister = unregistrations;
    ipcMain.emit('update-keybinds', {}, { toggleVisibility: 'Alt+V' });
    assert.equal(keybindWrites, 1, 'Keybinds must be persisted once');
    assert.equal(registrations, beforeUpdate + 1, 'Keybinds must be registered once');
    assert.equal(unregistrations, beforeUpdateUnregister + 1);
    assert.deepEqual(savedKeybinds, { toggleVisibility: 'Alt+V' });

    // Leave an initialization timer queued across close/reopen; it must not replace the new shortcuts.
    third.webContents.emit('dom-ready');
    third.close();
    app.emit('activate');
    const fourth = FakeBrowserWindow.getAllWindows()[0];
    assert.ok(fourth && fourth !== third, 'Activation must create a replacement window');
    flushTimers();
    assert.equal(shortcuts.size, 0, 'A closed window must not register shortcuts from a delayed callback');
    fourth.webContents.emit('dom-ready');
    flushTimers();
    shortcuts.get(keys.toggleClickThrough)();
    assert.equal(fourth.ignoresMouse, true, 'Click-through state must reset when a window closes');
    assert.equal(await handles.get('hide-window-for-screenshot')(), true);
    const lastShortcuts = [...shortcuts.values()];
    fourth.close();
    assert.equal(shortcuts.size, 0);
    assert.equal(await handles.get('hide-window-for-screenshot')(), false);
    assert.equal(await handles.get('show-window-after-screenshot')(), false);
    assert.doesNotThrow(() => handles.get('window-minimize')());
    assert.equal((await handles.get('toggle-window-visibility')()).success, false);
    assert.doesNotThrow(() => ipcMain.emit('view-changed', {}, 'assistant'));
    const registrationsAfterClose = registrations;
    ipcMain.emit('update-keybinds', {}, { toggleVisibility: 'Alt+X' });
    assert.equal(keybindWrites, 1, 'Keybind updates must be ignored without a live window');
    assert.equal(registrations, registrationsAfterClose);
    for (const callback of [...firstShortcuts, ...lastShortcuts]) await callback();
    flushTimers();

    // Restoring a screenshot must not restore a different window created after the hide.
    const fifth = createWindow(sendToRenderer, sessionRef);
    fifth.hide();
    assert.equal(await handles.get('show-window-after-screenshot')(), false);
    assert.equal(fifth.visible, false);

    const requestDisplayMedia = async () => {
        const results = [];
        displayMediaHandler({}, result => results.push(result));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(results.length, 1, 'Display capture must complete its callback exactly once');
        return results[0];
    };
    assert.deepEqual(await requestDisplayMedia(), { video: { id: 'screen:0' }, audio: 'loopback' });
    getSources = () => Promise.resolve([]);
    assert.deepEqual(await requestDisplayMedia(), {});
    getSources = () => Promise.reject(new Error('Screen access denied'));
    assert.deepEqual(await requestDisplayMedia(), {});
    fifth.close();
    console.log('Window lifecycle tests passed');
}

run()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Module._load = originalLoad;
        global.setTimeout = originalSetTimeout;
    });
