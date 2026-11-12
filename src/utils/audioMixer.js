// Mono Int16 LE PCM at a common sample rate. Consume equal sample spans from
// each stream so packet boundaries cannot interleave microphone/system audio.
function createAudioMixer(onAudio, { timeoutMs = 200, schedule = setTimeout, cancel = clearTimeout } = {}) {
    let buffers = { system: Buffer.alloc(0), mic: Buffer.alloc(0) };
    let timer = null;
    let closed = false;

    function push(source, chunk) {
        if (closed) return;
        if (source !== 'system' && source !== 'mic') throw new Error('Unknown audio source');
        if (chunk.length % 2 !== 0) throw new Error('PCM audio must contain whole Int16 samples');
        if (!chunk.length) return;
        buffers[source] = Buffer.concat([buffers[source], chunk]);

        const length = Math.min(buffers.system.length, buffers.mic.length);
        if (length) {
            const mixed = Buffer.alloc(length);
            for (let offset = 0; offset < length; offset += 2) {
                const sum = buffers.system.readInt16LE(offset) + buffers.mic.readInt16LE(offset);
                mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset);
            }
            buffers.system = buffers.system.subarray(length);
            buffers.mic = buffers.mic.subarray(length);
            onAudio(mixed);
        }

        if (!buffers.system.length && !buffers.mic.length && timer !== null) {
            cancel(timer);
            timer = null;
        }
        if ((buffers.system.length || buffers.mic.length) && timer === null) {
            timer = schedule(() => {
                timer = null;
                if (closed) return;
                const audio = buffers.system.length ? buffers.system : buffers.mic;
                buffers = { system: Buffer.alloc(0), mic: Buffer.alloc(0) };
                onAudio(audio);
            }, timeoutMs);
        }
    }

    function close() {
        closed = true;
        if (timer !== null) cancel(timer);
        timer = null;
        buffers = { system: Buffer.alloc(0), mic: Buffer.alloc(0) };
    }

    return { push, close };
}

module.exports = { createAudioMixer };
