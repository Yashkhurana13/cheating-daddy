const fs = require('fs');
const path = require('path');
const { getConfigDir } = require('../storage');

let logStream = null;
let isFirstEvent = true;
let currentLogPath = null;

function redactForLog(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(redactForLog);
    }

    return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => {
            if (typeof value === 'string') {
                if (/^(apiKey|key|token|authorization)$/i.test(key)) {
                    return [key, 'REDACTED'];
                }
                if (key === 'data' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
                    return [key, `[base64 ${Buffer.byteLength(value, 'base64')} bytes]`];
                }
            }
            return [key, redactForLog(value)];
        })
    );
}

function pruneTransportLogs(logsDirectory) {
    try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const name of fs.readdirSync(logsDirectory)) {
            try {
                const filePath = path.join(logsDirectory, name);
                const stats = fs.lstatSync(filePath);
                if (stats.isFile() && stats.mtimeMs < cutoff) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                // Pruning is best-effort; continue if a file is inaccessible or disappears.
            }
        }
    } catch {
        // A missing or inaccessible logs directory must not interrupt a session.
    }
}

function startTransportLog(sessionId, logsDirectory = path.join(getConfigDir(), 'logs')) {
    closeTransportLog();

    fs.mkdirSync(logsDirectory, { recursive: true });
    pruneTransportLogs(logsDirectory);

    currentLogPath = path.join(logsDirectory, `${sessionId}.json`);
    logStream = fs.createWriteStream(currentLogPath, { flags: 'w' });
    logStream.on('error', function (error) {
        console.error('Transport log stream error:', error.message);
    });
    isFirstEvent = true;
    logStream.write('[\n');

    logTransportEvent('session.started', { sessionId });
    console.log('Transport log:', currentLogPath);
}

function logTransportEvent(type, data) {
    if (!logStream) {
        return;
    }

    try {
        const event = {
            timestamp: Date.now(),
            type,
            data: redactForLog(data),
        };
        const prefix = isFirstEvent ? '' : ',\n';
        logStream.write(prefix + JSON.stringify(event));
        isFirstEvent = false;
    } catch (error) {
        console.error('Failed to write transport log event:', error.message);
    }
}

function closeTransportLog() {
    if (!logStream) {
        return;
    }

    logTransportEvent('session.closed', {});
    logStream.end('\n]\n');
    logStream = null;
    currentLogPath = null;
    isFirstEvent = true;
}

module.exports = {
    redactForLog,
    pruneTransportLogs,
    startTransportLog,
    logTransportEvent,
    closeTransportLog,
};
