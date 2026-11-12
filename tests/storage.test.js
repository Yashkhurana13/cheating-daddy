const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheating-daddy-storage-'));
const previousConfigDir = process.env.CHEATING_DADDY_CONFIG_DIR;
process.env.CHEATING_DADDY_CONFIG_DIR = configDir;

try {
    const storage = require('../src/storage');
    for (const [saved, expected] of [
        [{ ignoreTlsErrors: true, customPrompt: 'keep me', whisperModel: 'Xenova/whisper-base' }, false],
        [{ ignoreTlsErrors: true, tlsBypassMigrated: true, customPrompt: 'keep me' }, true],
        [{ ignoreTlsErrors: true, tlsBypassMigrated: false }, true],
        [{ ignoreTlsErrors: false, customPrompt: 'keep me' }, false],
        [null, false],
    ]) {
        const migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheating-daddy-tls-'));
        process.env.CHEATING_DADDY_CONFIG_DIR = migrationDir;
        try {
            const preferencesPath = path.join(migrationDir, 'preferences.json');
            if (saved !== null) {
                fs.writeFileSync(preferencesPath, JSON.stringify(saved));
            }
            storage.initializeStorage();
            assert.equal(storage.getPreferences().ignoreTlsErrors, expected);
            const migrated = fs.readFileSync(preferencesPath, 'utf8');
            const preferences = JSON.parse(migrated);
            if (saved !== null) {
                assert.deepEqual(preferences, {
                    ...saved,
                    ignoreTlsErrors: expected,
                    tlsBypassMigrated: saved.tlsBypassMigrated ?? true,
                });
            } else {
                assert.equal(preferences.ignoreTlsErrors, false);
                assert.equal(preferences.tlsBypassMigrated, true);
            }
            storage.initializeStorage();
            assert.equal(fs.readFileSync(preferencesPath, 'utf8'), migrated);
            // Opting in after migration must survive subsequent startups.
            assert.equal(storage.updatePreference('ignoreTlsErrors', true), true);
            storage.initializeStorage();
            assert.equal(storage.getPreferences().ignoreTlsErrors, true);
        } finally {
            process.env.CHEATING_DADDY_CONFIG_DIR = configDir;
            fs.rmSync(migrationDir, { recursive: true, force: true });
        }
    }

    assert.equal(storage.getConfigDir(), configDir);
    storage.initializeStorage();

    const configPath = path.join(configDir, 'config.json');
    const credentialsPath = path.join(configDir, 'credentials.json');
    const historyDir = path.join(configDir, 'history');
    const logsDir = path.join(configDir, 'logs');
    const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const assertNoTemps = () =>
        assert.deepEqual(
            fs.readdirSync(configDir).filter(file => file.endsWith('.tmp')),
            []
        );

    assert.equal(storage.getPreferences().ignoreTlsErrors, false);
    assert.equal(storage.setPreferences({ ignoreTlsErrors: true }), true);
    storage.initializeStorage();
    assert.equal(storage.getPreferences().ignoreTlsErrors, true);

    assert.equal(storage.setConfig({ onboarded: true }), true);
    assert.equal(readConfig().onboarded, true);
    assertNoTemps();

    // A failed replacement must preserve the old target and remove the temporary file.
    const renameSync = fs.renameSync;
    const consoleError = console.error;
    try {
        fs.renameSync = () => {
            throw new Error('Simulated rename failure');
        };
        console.error = () => {};
        assert.equal(storage.setConfig({ onboarded: false }), false);
    } finally {
        fs.renameSync = renameSync;
        console.error = consoleError;
    }
    assert.equal(readConfig().onboarded, true);
    assertNoTemps();

    assert.equal(storage.setCredentials({ apiKey: 'keep-this-key' }), true);
    assert.equal(storage.saveSession('123', { conversationHistory: ['keep this history'] }), true);
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, 'transport.json'), 'private transport log');
    fs.writeFileSync(path.join(logsDir, 'debug.log'), 'another log');
    const credentials = fs.readFileSync(credentialsPath, 'utf8');
    const history = fs.readFileSync(path.join(historyDir, '123.json'), 'utf8');

    // Recovery only replaces config.json, including on a missing-file startup.
    for (const badConfig of ['garbage', '{"configVersion":0}', '{"onboarded":true}', 'null']) {
        const previousBackups = fs.readdirSync(configDir).filter(file => file.startsWith('config.json.bak-'));
        fs.writeFileSync(configPath, badConfig);
        storage.initializeStorage();
        const newBackups = fs.readdirSync(configDir).filter(file => file.startsWith('config.json.bak-') && !previousBackups.includes(file));
        assert.equal(newBackups.length, 1);
        assert.equal(fs.readFileSync(path.join(configDir, newBackups[0]), 'utf8'), badConfig);
        assert.equal(readConfig().configVersion, 1);
        assert.equal(readConfig().onboarded, false);
        assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentials);
        assert.equal(fs.readFileSync(path.join(historyDir, '123.json'), 'utf8'), history);
        assert.equal(storage.getPreferences().ignoreTlsErrors, true);
        assert.equal(fs.readFileSync(path.join(logsDir, 'transport.json'), 'utf8'), 'private transport log');
    }
    fs.unlinkSync(configPath);
    storage.initializeStorage();
    assert.equal(readConfig().configVersion, 1);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentials);
    assert.equal(fs.readFileSync(path.join(historyDir, '123.json'), 'utf8'), history);

    for (const invalidId of ['../credentials', '', '1/2', '123\n', '123456789012345678901', -1, 1.5, NaN, null, undefined, {}, ['123']]) {
        assert.equal(storage.getSession(invalidId), null);
        assert.equal(storage.saveSession(invalidId, {}), false);
        assert.equal(storage.deleteSession(invalidId), false);
        assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentials);
    }
    assert.deepEqual(fs.readdirSync(historyDir), ['123.json']);

    for (const sessionId of [0, 456, '000789', '12345678901234567890']) {
        assert.equal(storage.saveSession(sessionId, { conversationHistory: ['hello'] }), true);
        assert.deepEqual(storage.getSession(sessionId).conversationHistory, ['hello']);
        assert.equal(storage.getSession(sessionId).sessionId, sessionId);
        assert.equal(storage.deleteSession(sessionId), true);
        assert.equal(storage.getSession(sessionId), null);
    }

    assert.equal(storage.deleteAllSessions(), true);
    assert.deepEqual(fs.readdirSync(historyDir), []);
    assert.deepEqual(fs.readdirSync(logsDir), []);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), credentials);

    // Missing-file defaults must be fresh copies, including nested arrays.
    fs.unlinkSync(credentialsPath);
    storage.getCredentials().apiKey = 'must not become a default';
    assert.equal(storage.getCredentials().apiKey, '');
    storage.getLimits().data.push({ date: '2000-01-01' });
    assert.deepEqual(storage.getLimits(), { data: [] });
    assert.equal(storage.getKeybinds(), null);
    assertNoTemps();
    console.log('Storage tests passed');
} finally {
    if (previousConfigDir === undefined) {
        delete process.env.CHEATING_DADDY_CONFIG_DIR;
    } else {
        process.env.CHEATING_DADDY_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
}
