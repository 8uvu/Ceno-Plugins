// Verifies Away: a DM is answered once, the cooldown holds, another chat gets
// its own reply, server channels, your own messages and bots are ignored, group
// DMs need their switch, the page reports what happened, a build without the
// message action says so instead of pretending, and stopping removes the
// listener.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

// Discord's design components, as functions, so the shared page kit draws its
// real path instead of falling back.
function addDesign(sandbox) {
    const D = sandbox.designStub;
    const element = (type, props) => ({ type, props: props ?? {}, children: props?.children });
    for (const name of [
        'TableRowGroup',
        'TableSwitchRow',
        'TableRow',
        'TableRadioGroup',
        'TableRadioRow',
        'Card',
        'Stack',
        'Text',
        'Button',
    ]) {
        const Component = function (props) {
            return element(Component, props);
        };
        Component.displayName = name;
        D[name] = Component;
    }
}

function rowsOf(tree) {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }
        const props = node.props ?? {};
        // Discord's Button carries its caption in `text`, its rows in `label`.
        const label = props.label ?? props.text ?? props.accessibilityLabel;
        if (typeof label === 'string') {
            out.push({ label, subLabel: props.subLabel, onPress: props.onPress });
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return out;
}

function stores() {
    return {
        UserStore: {
            getCurrentUser: () => ({ id: 'me' }),
            getUser: (id) => ({ id, username: id === 'ada' ? 'Ada' : id }),
        },
        ChannelStore: {
            getChannel: (id) => {
                if (id === 'dm1') return { id, type: 1, recipients: [{ id: 'ada', username: 'Ada' }] };
                if (id === 'dm2') return { id, type: 1, recipients: [{ id: 'bob', username: 'Bob' }] };
                if (id === 'group1') return { id, type: 3, name: 'the group' };
                if (id === 'guild1') return { id, type: 0, name: 'general', guild_id: 'g1' };
                return null;
            },
        },
    };
}

const message = (channelId, authorId, extra = {}) => ({
    message: {
        id: 'm' + Math.random().toString(36).slice(2),
        channel_id: channelId,
        content: 'hi',
        author: { id: authorId, username: authorId, ...(extra.author ?? {}) },
        ...extra,
    },
});

async function main() {
    const sent = [];
    const sandbox = createSandbox({ stores: stores() });
    addDesign(sandbox);
    sandbox.provide(
        {
            deleteMessage: () => {},
            sendMessage: (channelId, body) => {
                sent.push({ channelId, body });
            },
        },
        { provides: ['deleteMessage', 'sendMessage'] },
    );

    const inst = loadBundle('dev.8uvu.away', sandbox);
    await inst.start(sandbox.api);
    await tick();

    // Off by default: nothing is sent until it is turned on.
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    await tick();
    if (sent.length !== 0) throw new Error('Away answered while it was off');

    await sandbox.api.jsonStorage.set({ enabled: true, text: 'Away right now.' });

    // ── One DM, one reply ────────────────────────────────────────────────────
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    await tick();
    if (sent.length !== 1) throw new Error('the DM was not answered: ' + JSON.stringify(sent));
    if (sent[0].channelId !== 'dm1') throw new Error('the reply went to the wrong channel');
    if (sent[0].body?.content !== 'Away right now.') {
        throw new Error('the reply text is wrong: ' + JSON.stringify(sent[0].body));
    }
    if (!sandbox.toasts.includes('Sent the away reply.')) {
        throw new Error('no toast after sending: ' + JSON.stringify(sandbox.toasts));
    }

    // ── The cooldown ─────────────────────────────────────────────────────────
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    await tick();
    if (sent.length !== 1) throw new Error('the cooldown did not hold: ' + JSON.stringify(sent));

    // Another chat has its own cooldown.
    sandbox.emit('MESSAGE_CREATE', message('dm2', 'bob'));
    await tick();
    if (sent.length !== 2) throw new Error('the second DM was not answered');

    // ── Everyone else is ignored ─────────────────────────────────────────────
    sandbox.emit('MESSAGE_CREATE', message('guild1', 'ada'));
    sandbox.emit('MESSAGE_CREATE', message('dm1', 'me'));
    sandbox.emit('MESSAGE_CREATE', message('dm2', 'bot', { author: { bot: true } }));
    await tick();
    if (sent.length !== 2) {
        throw new Error('a server, your own message or a bot was answered: ' + JSON.stringify(sent));
    }

    // ── Group DMs need the switch ────────────────────────────────────────────
    sandbox.emit('MESSAGE_CREATE', message('group1', 'ada'));
    await tick();
    if (sent.length !== 2) throw new Error('a group DM was answered while switched off');
    await sandbox.api.jsonStorage.set({ groups: true });
    sandbox.emit('MESSAGE_CREATE', message('group1', 'ada'));
    await tick();
    if (sent.length !== 3) throw new Error('a group DM was not answered with the switch on');

    // ── The page ─────────────────────────────────────────────────────────────
    let page = inst.SettingsComponent({ api: sandbox.api });
    let text = textOf(page);
    for (const expected of [
        'Away is on',
        'Recent replies (3)',
        'Message action',
        'Found on this build.',
        'What it says',
        'Every 6 hours',
    ]) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    const forget = rowsOf(page).find((row) => row.label.startsWith('Forget recent replies'));
    if (!forget?.onPress) throw new Error('the page has no forget row');
    forget.onPress();
    await tick();
    if ((sandbox.stored.log ?? []).length !== 0) throw new Error('forget left replies behind');
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Nothing sent yet')) throw new Error('the page still lists replies: ' + text);

    // The hero turns it off.
    const off = rowsOf(inst.SettingsComponent({ api: sandbox.api })).find(
        (row) => row.label === 'Turn off' || row.label === 'Turn on',
    );
    if (off) off.onPress();
    await tick();

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('MESSAGE_CREATE', message('dm2', 'bob'));
    await tick();
    if (sent.length !== 3) throw new Error('a reply was sent while switched off');

    // ── Stop removes the listener ────────────────────────────────────────────
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    let listened = true;
    try {
        sandbox.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    } catch {
        listened = false;
    }
    if (listened) throw new Error('the message listener survived stopping');

    // ── A build without the action says so ──────────────────────────────────
    const bare = createSandbox({ stores: stores() });
    addDesign(bare);
    const second = loadBundle('dev.8uvu.away', bare);
    await second.start(bare.api);
    await bare.api.jsonStorage.set({ enabled: true });
    bare.emit('MESSAGE_CREATE', message('dm1', 'ada'));
    await tick();
    const bareText = textOf(second.SettingsComponent({ api: bare.api }));
    if (!bareText.includes('Not found on this build')) {
        throw new Error('a build without the action did not say so: ' + bareText);
    }
    if (!bare.toasts.some((entry) => entry.includes('does not expose the message action'))) {
        throw new Error('a build without the action did not explain the failure');
    }

    console.log('VERIFY OK: DM answered once, cooldown holds, second chat answered, servers/self/bots ignored, group switch, page and log, missing action explained');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
