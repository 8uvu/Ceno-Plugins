// Verifies Second Thoughts: a text send is held, cancelling it never reaches
// Discord and keeps the text on the page, attachments and server channels pass
// straight through, the switch sends at once, the queue is ordered, and stop
// drops held sends instead of flushing them late.
const { createSandbox, loadBundle, pressables, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const delivered = [];
    const sendMessage = (channelId, message) => {
        delivered.push({ channelId, message });
        return Promise.resolve(message);
    };
    const actions = { deleteMessage: () => {}, sendMessage };

    const sandbox = createSandbox({
        design: false,
        stores: {
            UserStore: { getCurrentUser: () => ({ id: 'me' }), getUser: (id) => ({ id, username: 'ada' }) },
            ChannelStore: {
                getChannel: (id) => ({ id, type: id === 'dm1' ? 1 : 0, name: id === 'dm1' ? 'ada' : 'general' }),
            },
        },
    });
    sandbox.provide(actions, { provides: ['deleteMessage', 'sendMessage'] });

    const inst = loadBundle('dev.8uvu.second-thoughts', sandbox);
    await inst.start(sandbox.api);
    await sandbox.api.jsonStorage.set({ enabled: true, delay: 3, holdDms: true, holdServers: false });
    await tick();

    // A DM message is held, listed, and can be cancelled from the page.
    const held = actions.sendMessage('dm1', { content: 'oops wrong chat' });
    await tick();
    if (delivered.length) throw new Error('the send was not held');
    const queued = sandbox.stored.pending ?? [];
    if (queued.length !== 1) throw new Error('the held send was not listed: ' + JSON.stringify(sandbox.stored));
    if (!sandbox.toasts.some((text) => text.includes('Sending in 3s'))) {
        throw new Error('no hold toast: ' + JSON.stringify(sandbox.toasts));
    }

    const ui = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(ui);
    for (const expected of ['Second Thoughts', 'Hold my messages', 'Waiting to send', 'oops wrong chat']) {
        if (!text.includes(expected)) throw new Error('settings UI is missing: ' + expected);
    }
    const row = pressables(ui).find((node) => String(node.props.accessibilityLabel).includes('oops wrong chat'));
    if (!row) throw new Error('the waiting message has no cancel row');
    row.props.onPress();
    await tick();
    await held;

    if (delivered.length) throw new Error('a cancelled send still reached Discord');
    const cancelled = sandbox.stored.cancelled ?? [];
    if (cancelled.length !== 1 || cancelled[0].content !== 'oops wrong chat') {
        throw new Error('the cancelled text was not kept: ' + JSON.stringify(sandbox.stored.cancelled));
    }
    if ((sandbox.stored.pending ?? []).length) throw new Error('the cancelled send stayed in the queue');

    // Attachments, server channels and the switch off all go straight through.
    delivered.length = 0;
    await actions.sendMessage('dm1', { content: 'a picture', attachments: [{ id: '1' }] });
    if (delivered.length !== 1) throw new Error('an attachment was held');
    await actions.sendMessage('srv1', { content: 'server message' });
    if (delivered.length !== 2) throw new Error('a server channel was held while holdServers is off');
    await sandbox.api.jsonStorage.set({ enabled: false });
    await tick();
    await actions.sendMessage('dm1', { content: 'switched off' });
    if (delivered.length !== 3) throw new Error('a send was held while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });
    await tick();

    // Two held sends go out in the order they were typed.
    delivered.length = 0;
    const first = actions.sendMessage('dm1', { content: 'first' });
    const second = actions.sendMessage('dm1', { content: 'second' });
    await tick();
    if ((sandbox.stored.pending ?? []).length !== 2) {
        throw new Error('both sends were not queued: ' + JSON.stringify(sandbox.stored.pending));
    }
    await first;
    await second;
    const order = delivered.map((entry) => String(entry.message?.content));
    if (order.join(',') !== 'first,second') throw new Error('the queue was reordered: ' + JSON.stringify(order));
    if ((sandbox.stored.pending ?? []).length) throw new Error('the queue was not cleared after sending');

    // Stopping drops what is waiting instead of sending it late.
    delivered.length = 0;
    const dropped = actions.sendMessage('dm1', { content: 'never mind' });
    await tick();
    if ((sandbox.stored.pending ?? []).length !== 1) throw new Error('the send was not held before stop');
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    await dropped;
    await wait(50);
    if (delivered.length) throw new Error('a held send went out after stop');
    if ((sandbox.stored.pending ?? []).length) throw new Error('the queue survived stop');
    if (actions.sendMessage !== sendMessage) throw new Error('the send action was not put back');

    console.log('VERIFY OK: hold, cancel from the page with the text kept, pass-through cases, queue order, stop drops instead of flushing');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
