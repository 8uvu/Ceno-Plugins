// Verifies Waiting on You: a DM whose last message is theirs is listed, your
// reply takes it off, group DMs need their switch, the page orders the oldest
// first, a row can be dismissed, forget-all works, switching off stops new
// entries, and stopping removes the listener.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

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

const HOUR = 60 * 60 * 1000;

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: {
                getCurrentUser: () => ({ id: 'me' }),
                getUser: (id) => ({ id, username: id === 'ada' ? 'Ada' : 'Bob' }),
            },
            ChannelStore: {
                getChannel: (id) => {
                    if (id === 'dm1') return { id, type: 1, recipients: [{ id: 'ada', username: 'Ada' }] };
                    if (id === 'dm2') return { id, type: 1, recipients: [{ id: 'bob', username: 'Bob' }] };
                    if (id === 'group1') return { id, type: 3, name: 'the group' };
                    return null;
                },
            },
        },
    });
    addDesign(sandbox);

    const inst = loadBundle('dev.8uvu.waiting-on-you', sandbox);
    await inst.start(sandbox.api);
    await tick();

    let counter = 0;
    const send = (channelId, authorId, content, at = Date.now()) =>
        sandbox.emit('MESSAGE_CREATE', {
            message: {
                id: 'm' + ++counter,
                channel_id: channelId,
                content,
                timestamp: new Date(at).toISOString(),
                author: { id: authorId, username: authorId },
            },
        });

    // ── Their message puts the chat on the list ──────────────────────────────
    const first = Date.now() - 2 * HOUR;
    send('dm1', 'ada', 'are you around?', first);
    await tick();
    let chats = sandbox.stored.chats ?? {};
    if (!chats.dm1) throw new Error('the DM was not listed: ' + JSON.stringify(chats));
    if (chats.dm1.name !== 'Ada') throw new Error('wrong name: ' + chats.dm1.name);
    if (chats.dm1.preview !== 'are you around?') throw new Error('wrong preview: ' + chats.dm1.preview);
    if (Math.abs(chats.dm1.at - first) > 5000) throw new Error('wrong time: ' + chats.dm1.at);

    send('dm2', 'bob', 'hello', Date.now() - HOUR);
    await tick();

    // ── Your reply takes it off ──────────────────────────────────────────────
    send('dm1', 'me', 'yes');
    await tick();
    if ((sandbox.stored.chats ?? {}).dm1) throw new Error('your reply did not clear the chat');
    if (!(sandbox.stored.chats ?? {}).dm2) throw new Error('the other chat was cleared too');

    // ── Group DMs need the switch ────────────────────────────────────────────
    send('group1', 'ada', 'ping', Date.now() - 5 * 60 * 1000);
    await tick();
    if ((sandbox.stored.chats ?? {}).group1) throw new Error('a group DM was listed while switched off');
    await sandbox.api.jsonStorage.set({ groups: true });
    send('group1', 'ada', 'ping again', Date.now() - 5 * 60 * 1000);
    await tick();
    if (!(sandbox.stored.chats ?? {}).group1) throw new Error('a group DM was not listed with the switch on');

    // ── The page ─────────────────────────────────────────────────────────────
    let page = inst.SettingsComponent({ api: sandbox.api });
    let text = textOf(page);
    for (const expected of [
        '2 chats are waiting on you',
        'The oldest is Bob',
        'Waiting on you (2)',
        'hello',
        'Include group DMs',
    ]) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Dismissing one ───────────────────────────────────────────────────────
    const bobRow = rowsOf(page).find((row) => row.label.startsWith('Bob ·'));
    if (!bobRow?.onPress) throw new Error('the waiting row cannot be tapped');
    bobRow.onPress();
    await tick();
    if ((sandbox.stored.chats ?? {}).dm2) throw new Error('dismissing did not clear the chat');
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('1 chat is waiting on you')) {
        throw new Error('the count did not update: ' + text);
    }

    // ── Forget everyone ─────────────────────────────────────────────────────
    const forget = rowsOf(inst.SettingsComponent({ api: sandbox.api })).find(
        (row) => row.label === 'Forget everyone',
    );
    if (!forget?.onPress) throw new Error('the page has no forget-everyone row');
    forget.onPress();
    await tick();
    if (Object.keys(sandbox.stored.chats ?? {}).length !== 0) throw new Error('forget left a chat behind');
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Nobody is waiting on you')) throw new Error('the page still lists chats: ' + text);

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    send('dm1', 'ada', 'again');
    await tick();
    if ((sandbox.stored.chats ?? {}).dm1) throw new Error('a chat was listed while switched off');

    // ── Stop ─────────────────────────────────────────────────────────────────
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    let listened = true;
    try {
        send('dm2', 'bob', 'still there?');
    } catch {
        listened = false;
    }
    if (listened) throw new Error('the message listener survived stopping');

    console.log('VERIFY OK: their message lists the chat, your reply clears it, group switch, oldest-first page, dismiss, forget-all, switched off, listener removed');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
