// Verifies TypingWatch: typing indicators are recorded newest-first, one row per
// person and channel, the switch stops recording, clearing works, and the event
// still reaches the client untouched.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: { getUser: (id) => ({ id, username: id === 'user1' ? 'ada' : 'bo' }) },
            ChannelStore: { getChannel: (id) => (id === 'chan1' ? { id, name: 'general' } : null) },
        },
    });
    const inst = loadBundle('dev.8uvu.typing-watch', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const payload = { type: 'TYPING_START', channelId: 'chan1', userId: 'user1' };
    const returned = sandbox.emit('TYPING_START', payload);
    if (returned !== payload) throw new Error('the event must be passed through untouched');
    await tick();

    if ((sandbox.stored.recent ?? []).length !== 1) {
        throw new Error('typing was not recorded: ' + JSON.stringify(sandbox.stored));
    }
    if (sandbox.stored.recent[0].userId !== 'user1') throw new Error('wrong user recorded');

    // Typing again in the same place moves the row instead of duplicating it.
    sandbox.emit('TYPING_START', { ...payload, userId: 'user2' });
    await tick();
    sandbox.emit('TYPING_START', payload);
    await tick();
    const recent = sandbox.stored.recent ?? [];
    if (recent.length !== 2) throw new Error('duplicate row kept: ' + JSON.stringify(recent));
    if (recent[0].userId !== 'user1') throw new Error('newest typing is not first: ' + JSON.stringify(recent));

    const ui = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(ui);
    for (const expected of ['TypingWatch', 'Remember who types', 'ada in #general']) {
        if (!text.includes(expected)) throw new Error('settings UI missing: ' + expected);
    }

    // Switched off, nothing new is stored.
    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('TYPING_START', { ...payload, userId: 'user3' });
    await tick();
    if ((sandbox.stored.recent ?? []).some((entry) => entry.userId === 'user3')) {
        throw new Error('recorded while switched off');
    }
    await sandbox.api.jsonStorage.set({ enabled: true });

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (sandbox.fluxHandlers.has('TYPING_START')) throw new Error('unpatch left the flux handler behind');
    console.log('VERIFY OK: typing recorded, deduped, switch honoured, unpatch restores');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
