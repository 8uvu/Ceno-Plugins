// Verifies Don't Control Me: rejoin behaviour is configurable, the pin wins when
// there is one, a server mute is undone in the call, and pressing Disconnect
// yourself is not undone.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const ME = '100000000000000001';
    let current = '444';
    const selected = [];
    const stateUpdates = [];
    // The client's own voice action object: the plugin patches its
    // selectVoiceChannel to notice a disconnect the user started.
    const voiceActions = {
        selectVoiceChannel: (id) => {
            selected.push(String(id));
            current = id === null || id === undefined ? null : String(id);
        },
    };
    const sandbox = createSandbox({
        stores: {
            UserStore: { getCurrentUser: () => ({ id: ME }) },
            SelectedChannelStore: { getVoiceChannelId: () => current },
            VoiceStateStore: {
                getVoiceStateForUser: () => (current ? { channelId: current } : null),
            },
            ChannelStore: { getChannel: (id) => ({ id, name: 'general' }) },
        },
    });
    sandbox.provide(voiceActions, { provides: ['selectVoiceChannel'] });
    sandbox.provide(
        {
            updateVoiceState: (channelId, state) =>
                stateUpdates.push({ channelId: String(channelId), ...state }),
        },
        { provides: ['updateVoiceState'] },
    );

    const inst = loadBundle('dev.8uvu.dont-control-me', sandbox);
    await inst.start(sandbox.api);

    // The page names the channel it would rejoin; give it a pin to name.
    await sandbox.api.jsonStorage.set({ pinnedChannelId: '444' });
    await tick();
    const ui = inst.SettingsComponent({ api: sandbox.api });
    const rendered = textOf(ui);
    for (const want of [
        "Don't Control Me",
        'Rejoin when I get disconnected',
        'Wait before rejoining',
        '#general',
        'Join action',
    ]) {
        if (!rendered.includes(want)) throw new Error('settings UI is missing: ' + want);
    }

    const drop = async () => {
        current = null;
        sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: null, guildId: '1' } });
        await tick();
        await wait(40);
        await tick();
    };

    // Pinned channel wins over everything else.
    await sandbox.api.jsonStorage.set({ reconnect: true, rejoinDelay: 0, pinnedChannelId: '444', lastChannelId: null });
    await tick();
    await drop();
    if (!selected.includes('444')) throw new Error('did not rejoin the pinned channel: ' + JSON.stringify(selected));

    // With no pin, the last call is remembered and rejoined.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({ pinnedChannelId: null });
    await tick();
    current = '777';
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: '777', guildId: '1' } });
    await tick();
    const remembered = sandbox.api.jsonStorage.cache?.lastChannelId;
    if (remembered !== '777') throw new Error('the last call was not remembered: ' + remembered);
    await drop();
    if (!selected.includes('777')) throw new Error('did not rejoin the last call: ' + JSON.stringify(selected));

    // Switched off: a drop must leave you out of voice.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({ reconnect: false });
    await tick();
    await drop();
    if (selected.length) throw new Error('rejoined while switched off: ' + JSON.stringify(selected));

    // Someone else moving never triggers anything.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({ reconnect: true, rejoinDelay: 0 });
    await tick();
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: 'other', channelId: '999', guildId: '1' } });
    await tick();
    if (selected.length) throw new Error('reacted to another user moving');

    // Being moved out of the pin is undone.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({ pinnedChannelId: '444', moveToPinned: true });
    await tick();
    current = '999';
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: '999', guildId: '1' } });
    await tick();
    if (!selected.includes('444')) throw new Error('did not move back to the pin');

    // A server mute while in the call is undone. This used to sit behind the
    // "out of voice" branch, so it could never run.
    stateUpdates.length = 0;
    await sandbox.api.jsonStorage.set({ pinnedChannelId: null, moveToPinned: true, rejoinDelay: 0, reconnect: true });
    await tick();
    current = '777';
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: '777', guildId: '1' } });
    await tick();
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: '777', guildId: '1', mute: true } });
    await tick();
    if (!stateUpdates.some((s) => s.channelId === '777' && s.mute === false)) {
        throw new Error('a server mute in the call was not undone: ' + JSON.stringify(stateUpdates));
    }

    // With "return to my pin" off, the last call is the target, not the pin.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({
        pinnedChannelId: '444',
        moveToPinned: false,
        lastChannelId: '777',
        rejoinDelay: 0,
    });
    await tick();
    await drop();
    if (!selected.includes('777')) throw new Error('did not rejoin the last call with the pin off: ' + JSON.stringify(selected));
    if (selected.includes('444')) throw new Error('rejoined the pin while "return to my pin" was off');

    // Pressing Disconnect yourself is not undone a second later.
    selected.length = 0;
    await sandbox.api.jsonStorage.set({ pinnedChannelId: null, moveToPinned: true, reconnect: true, rejoinDelay: 0, lastChannelId: '777' });
    await tick();
    voiceActions.selectVoiceChannel(null);
    sandbox.emit('VOICE_STATE_UPDATE', { voiceState: { userId: ME, channelId: null, guildId: '1' } });
    await tick();
    await wait(60);
    await tick();
    if (selected.includes('777')) throw new Error('undid a disconnect the user started: ' + JSON.stringify(selected));

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    console.log('VERIFY OK: rejoin on drop (pin, then last call), delay setting, switched off, ignores others, move-back, undo server mute in call, own Disconnect left alone');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
