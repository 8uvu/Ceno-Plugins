// Verifies TypingTally: your own typing is counted per channel for today, the
// switch stops counting, reset clears, and the event passes through untouched.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

async function main() {
    const sandbox = createSandbox();
    const inst = loadBundle('dev.8uvu.typing-tally', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const payload = { type: 'TYPING_START_LOCAL', channelId: 'chan1' };
    const returned = sandbox.emit('TYPING_START_LOCAL', payload);
    if (returned !== payload) throw new Error('the event must be passed through untouched');
    await tick();
    sandbox.emit('TYPING_START_LOCAL', payload);
    sandbox.emit('TYPING_START_LOCAL', { type: 'TYPING_START_LOCAL', channelId: 'chan2' });
    await tick();

    const counts = sandbox.stored.counts ?? {};
    if (counts.chan1 !== 2) throw new Error('chan1 not counted twice: ' + JSON.stringify(counts));
    if (counts.chan2 !== 1) throw new Error('chan2 not counted: ' + JSON.stringify(counts));

    const text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['TypingTally', 'Count my typing', 'Channel chan1']) {
        if (!text.includes(expected)) throw new Error('settings UI missing: ' + expected);
    }

    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('TYPING_START_LOCAL', { type: 'TYPING_START_LOCAL', channelId: 'chan3' });
    await tick();
    if ((sandbox.stored.counts ?? {}).chan3) throw new Error('counted while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });

    await sandbox.api.jsonStorage.set({ counts: {} });
    if (Object.keys(sandbox.stored.counts ?? {}).length !== 0) throw new Error('reset did not clear');

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (sandbox.fluxHandlers.has('TYPING_START_LOCAL')) throw new Error('unpatch left the flux handler behind');
    console.log('VERIFY OK: typing counted per channel, switch honoured, unpatch restores');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
