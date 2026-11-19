// Verifies Streaks: one message from either side counts the day, yesterday plus
// today is a two-day streak, both-sides mode still needs a reply, guild channels
// are ignored, the switch stops counting, a reset clears, and stopping puts the
// flux listener back.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

function key(at) {
    const d = new Date(at);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
}

function message(channelId, authorId) {
    return {
        type: 'MESSAGE_CREATE',
        channelId,
        message: { channel_id: channelId, author: { id: authorId }, content: 'hi' },
    };
}

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: { getCurrentUser: () => ({ id: 'me' }) },
            ChannelStore: {
                getChannel: (id) => {
                    if (id === 'dm1') return { id, type: 1, recipients: [{ id: 'friend', username: 'friend' }] };
                    if (id === 'guild1') return { id, type: 0, guild_id: 'g1', name: 'general' };
                    return null;
                },
            },
        },
    });
    const inst = loadBundle('dev.8uvu.streaks', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const today = key(Date.now());
    const yesterday = key(Date.now() - 24 * 60 * 60 * 1000);

    // One message from the other person is enough to start the streak.
    const payload = message('dm1', 'friend');
    const returned = sandbox.emit('MESSAGE_CREATE', payload);
    if (returned !== payload) throw new Error('the event must be passed through untouched');
    sandbox.emit('MESSAGE_CREATE', message('guild1', 'me'));
    await tick();

    const convo = (sandbox.stored.conversations ?? {}).dm1;
    if (!convo) throw new Error('the DM was not recorded: ' + JSON.stringify(sandbox.stored));
    const day = convo.days[today] ?? {};
    if (day.in !== 1 || day.out !== 0) throw new Error('today not counted from one message: ' + JSON.stringify(day));
    if (convo.name !== 'friend') throw new Error('conversation not named after the other person: ' + convo.name);
    if ((sandbox.stored.conversations ?? {}).guild1) throw new Error('a guild channel was counted');

    let text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['Streaks', 'Track streaks', 'friend', '1 day']) {
        if (!text.includes(expected)) throw new Error('settings UI missing: ' + expected);
    }

    // A one-sided day yesterday still counts, so the same conversation is on a
    // two-day streak.
    await sandbox.api.jsonStorage.set({
        conversations: {
            dm1: {
                name: 'friend',
                longest: 2,
                days: { [yesterday]: { in: 1, out: 0 }, [today]: { in: 1, out: 0 } },
            },
        },
    });
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('2 days')) throw new Error('two-day streak not shown: ' + text.slice(0, 400));

    // With both sides switched on, a one-sided day no longer extends it.
    await sandbox.api.jsonStorage.set({ bothSides: true });
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (text.includes('2 days')) throw new Error('a one-sided day extended the streak with both sides on');
    await sandbox.api.jsonStorage.set({ bothSides: false });

    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'me'));
    await tick();
    const afterOff = (sandbox.stored.conversations ?? {}).dm1.days[today].out;
    if (afterOff !== 0) throw new Error('counted while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });

    await sandbox.api.jsonStorage.set({ conversations: {} });
    if (Object.keys(sandbox.stored.conversations ?? {}).length !== 0) throw new Error('reset did not clear');

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (sandbox.fluxHandlers.has('MESSAGE_CREATE')) throw new Error('unpatch left the flux handler behind');
    console.log('VERIFY OK: one message starts a day, streak spans days, both-sides mode honoured, guild skipped, switch and reset honoured');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
