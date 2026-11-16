// Verifies Don't Control Me: rejoin behaviour is configurable, and the pin wins
// when there is one.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const ME = '100000000000000001';
    let current = '444';
    const selected = [];
    const sandbox = createSandbox({
        stores: {
            UserStore: { getCurrentUser: () => ({ id: ME }) },
            SelectedChannelStore: { getVoiceChannelId: () => current },
        },
    });
    sandbox.provide(
        {
            selectVoiceChannel: (id) => {
                selected.push(String(id));
                current = String(id);
            },
        },
        { provides: ['selectVoiceChannel'] },
    );
    sandbox.provide({ updateVoiceState: () => {} }, { provides: ['updateVoiceState'] });

    const inst = loadBundle('dev.8uvu.dont-control-me', sandbox);
    await inst.start(sandbox.api);

    const ui = inst.SettingsComponent({ api: sandbox.api });
    const rendered = textOf(ui);
    for (const want of ["Don't Control Me", 'Rejoin when I get disconnected', 'Wait before rejoining']) {
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

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    console.log('VERIFY OK: rejoin on drop (pin, then last call), delay setting, switched off, ignores others, move-back');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
