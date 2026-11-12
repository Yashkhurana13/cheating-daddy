(function () {
    function createStartGuard() {
        let starting = false;
        return async start => {
            if (starting) return;
            starting = true;
            try {
                return await start();
            } finally {
                starting = false;
            }
        };
    }

    function handleMicFailure(audioMode, error) {
        if (audioMode !== 'both') throw error;
    }

    // Weak sets also make repeated/concurrent cleanup safe without retaining media.
    const stoppedTracks = new WeakSet();
    const closedContexts = new WeakSet();

    async function stopAllMedia({ streams = [], contexts = [] }) {
        const errors = [];
        for (const stream of streams) {
            if (!stream) continue;
            for (const track of stream.getTracks()) {
                if (stoppedTracks.has(track)) continue;
                stoppedTracks.add(track);
                try {
                    track.stop();
                } catch (error) {
                    errors.push(error);
                }
            }
        }

        await Promise.all(
            contexts.map(async context => {
                if (!context || closedContexts.has(context)) return;
                closedContexts.add(context);
                try {
                    if (context.state !== 'closed') await context.close();
                } catch (error) {
                    errors.push(error);
                }
            })
        );
        return errors;
    }

    const captureLifecycle = { createStartGuard, stopAllMedia, handleMicFailure };
    if (typeof module !== 'undefined' && module.exports) module.exports = captureLifecycle;
    if (typeof window !== 'undefined') window.captureLifecycle = captureLifecycle;
})();
