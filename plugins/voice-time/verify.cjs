// Verifies Voice Time: calls are opened, switched and closed with the right
// length, shared time is counted from the moment each person joined and left,
// short calls are dropped, the switch stops everything, and a call left open by
// a previous run is never billed to now.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const realNow = Date.now;
let clock = new Date('2026-11-26T12:00:00Z').getTime();
Date.now = () => clock;
const advance = (ms) => {
    clock += ms;
};

async function main() {
    const ME = '100000000000000001';
    const ADA = '200000000000000002';
    let seated = {};
    const sandbox = createSandbox({
        stores: {
            UserStore: {
                getCurrentUser: () => ({ id: ME }),
                getUser: (id) => ({ id, username: id === ME ? 'me' : 'ada' }),
            },
            ChannelStore: {
                getChannel: (id) => ({ id, type: 2, name: id === '444' ? 'general' : 'lounge' }),
            },
            VoiceStateStore: {
                getVoiceStatesForChannel: () => seated,
            },
        },
    });

    // A call that was open when the app last closed: no hours can be trusted.
    sandbox.stored.open = {
        channelId: '444',
        guildId: '1',
        startedAt: clock - 3_600_000,
        with: {},
        shared: {},
    };

    const inst = loadBundle('dev.8uvu.voice-time', sandbox);
    await inst.start(sandbox.api);
    if (sandbox.stored.open) throw new Error('a stale open call was kept');
    if ((sandbox.stored.calls ?? []).length) throw new Error('a stale open call was logged');

    const me = (channelId) =>
        sandbox.emit('VOICE_STATE_UPDATE', {
            voiceState: { userId: ME, channelId, guildId: '1' },
        });
    const them = (userId, channelId) =>
        sandbox.emit('VOICE_STATE_UPDATES', {
            voiceStates: [{ userId, channelId, guildId: '1' }],
        });
    const calls = () => sandbox.stored.calls ?? [];

    // One call, from joining to leaving, with a repeat announcement in between.
    me('444');
    await tick();
    advance(5 * 60_000);
    me('444');
    await tick();
    advance(60_000);
    me(null);
    await tick();
    if (calls().length !== 1) throw new Error('expected one call: ' + JSON.stringify(calls()));
    if (calls()[0].ms !== 6 * 60_000) throw new Error('wrong call length: ' + calls()[0].ms);
    if (!sandbox.toasts.some((text) => text.includes('You were in #general'))) {
        throw new Error('no recap toast: ' + JSON.stringify(sandbox.toasts));
    }

    // Switching channels closes the first call at that instant.
    me('444');
    await tick();
    advance(60_000);
    me('777');
    await tick();
    advance(60_000);
    me(null);
    await tick();
    if (calls().length !== 3) throw new Error('switching did not log both calls: ' + JSON.stringify(calls()));
    if (calls()[0].channelId !== '777' || calls()[0].ms !== 60_000) throw new Error('the second call is wrong');
    if (calls()[1].channelId !== '444' || calls()[1].ms !== 60_000) throw new Error('the first call is wrong');

    // Under ten seconds is a mistake, not a call.
    me('444');
    await tick();
    advance(3000);
    me(null);
    await tick();
    if (calls().length !== 3) throw new Error('a three-second call was logged');

    // Shared time: Ada joins after me and leaves early; only her minutes count.
    me('444');
    await tick();
    advance(10_000);
    them(ADA, '444');
    await tick();
    advance(60_000);
    them(ADA, null);
    await tick();
    advance(60_000);
    me(null);
    await tick();
    const ada = (sandbox.stored.people ?? []).find((person) => person.id === ADA);
    if (!ada) throw new Error('shared time was not recorded: ' + JSON.stringify(sandbox.stored.people));
    if (ada.ms !== 60_000) throw new Error('Ada was credited ' + ada.ms + 'ms, expected 60000');
    if (ada.name !== 'ada') throw new Error('the person has no name');
    if (calls()[0].ms !== 130_000) throw new Error('the call length is wrong: ' + calls()[0].ms);

    // Someone already seated when I join is counted from my join.
    seated = { [ADA]: { userId: ADA, channelId: '444' } };
    const before = (sandbox.stored.people ?? []).find((person) => person.id === ADA)?.ms ?? 0;
    me('444');
    await tick();
    advance(30_000);
    me(null);
    await tick();
    const after = (sandbox.stored.people ?? []).find((person) => person.id === ADA)?.ms ?? 0;
    if (after - before !== 30_000) throw new Error('a person already in the channel was not counted: ' + (after - before));
    seated = {};

    // Other people moving while I am not in a call changes nothing.
    const size = calls().length;
    them(ADA, '777');
    await tick();
    them(ADA, null);
    await tick();
    if (calls().length !== size) throw new Error('another person created a call');

    // Switched off: nothing new is written.
    await sandbox.api.jsonStorage.set({ enabled: false });
    await tick();
    me('777');
    await tick();
    advance(60_000);
    me(null);
    await tick();
    if (calls().length !== size) throw new Error('recorded a call while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });
    await tick();

    const ui = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(ui);
    for (const expected of ['Voice Time', 'Record my calls', 'Today', '#general', 'ada']) {
        if (!text.includes(expected)) throw new Error('settings UI is missing: ' + expected);
    }

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    for (const event of ['VOICE_STATE_UPDATE', 'VOICE_STATE_UPDATES']) {
        if (sandbox.fluxHandlers.has(event)) throw new Error('unpatch left ' + event + ' behind');
    }
    console.log('VERIFY OK: calls logged with length, switching splits, short calls dropped, per-person time banked, switch off, stale session dropped, unpatch restores');
}

main()
    .catch((error) => {
        console.error('VERIFY FAILED:', error?.message ?? error);
        process.exit(1);
    })
    .finally(() => {
        Date.now = realNow;
    });
