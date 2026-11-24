// Verifies Message Logger: an edit is logged with the text before and after, an
// unchanged edit is not, a deletion is logged with the last text, the switch
// stops recording, the cap holds, the page lists the entries, and clearing
// empties the log.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const ADA = 'ada';
const CHANNEL = 'chan1';

const created = (id, content, author = ADA) => ({
    message: {
        id,
        channel_id: CHANNEL,
        content,
        author: { id: author, username: author === ADA ? 'Ada' : author },
    },
});
const edited = (id, content) => ({ message: { id, content } });
const deleted = (id) => ({ id, channelId: CHANNEL });

// A row on the settings page, by the start of its label.
function findRow(tree, prefix) {
    let found = null;
    const seen = new Set();
    const walk = (node) => {
        if (!node || typeof node !== 'object' || seen.has(node) || found) return;
        seen.add(node);
        if (Array.isArray(node)) {
            for (const child of node) walk(child);
            return;
        }
        const props = node.props ?? {};
        if (typeof props.label === 'string' && props.label.startsWith(prefix)) {
            found = { label: props.label, onPress: props.onPress };
            return;
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return found;
}

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: { getUser: (id) => ({ id, username: id === ADA ? 'Ada' : id }) },
            ChannelStore: {
                getChannel: (id) => (id === CHANNEL ? { id, name: 'general', guild_id: 'g1' } : null),
            },
        },
    });

    const inst = loadBundle('dev.8uvu.message-logger', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const log = () => sandbox.stored.log ?? [];

    // ── An edit ──────────────────────────────────────────────────────────────
    sandbox.emit('MESSAGE_CREATE', created('m1', 'hello'));
    await tick();
    if (log().length) throw new Error('a plain message was logged');

    sandbox.emit('MESSAGE_UPDATE', edited('m1', 'hello there'));
    await tick();
    if (log().length !== 1) throw new Error('the edit was not logged: ' + JSON.stringify(log()));
    const first = log()[0];
    if (first.kind !== 'edited') throw new Error('the entry is not an edit');
    if (first.before !== 'hello' || first.after !== 'hello there') {
        throw new Error('wrong before/after: ' + JSON.stringify(first));
    }
    if (first.authorName !== 'Ada') throw new Error('wrong author: ' + first.authorName);
    if (first.channelName !== '#general') throw new Error('wrong channel: ' + first.channelName);

    // An update that changes nothing is not an edit.
    sandbox.emit('MESSAGE_UPDATE', edited('m1', 'hello there'));
    await tick();
    if (log().length !== 1) throw new Error('an unchanged message was logged');

    // ── A deletion ───────────────────────────────────────────────────────────
    sandbox.emit('MESSAGE_DELETE', deleted('m1'));
    await tick();
    if (log().length !== 2) throw new Error('the deletion was not logged: ' + JSON.stringify(log()));
    if (log()[0].kind !== 'deleted') throw new Error('the newest entry is not the deletion');
    if (log()[0].before !== 'hello there') throw new Error('the deletion kept the wrong text');

    // A message the plugin never saw cannot be logged.
    sandbox.emit('MESSAGE_DELETE', deleted('unknown'));
    await tick();
    if (log().length !== 2) throw new Error('a message that was never seen was logged');

    // ── The page ─────────────────────────────────────────────────────────────
    let text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['Message Logger', 'Clear the log (2)', 'Ada · #general', 'Deleted:']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('MESSAGE_CREATE', created('m2', 'quiet'));
    sandbox.emit('MESSAGE_UPDATE', edited('m2', 'changed'));
    sandbox.emit('MESSAGE_DELETE', deleted('m2'));
    await tick();
    if (log().length !== 2) throw new Error('the log grew while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });

    // ── The cap ──────────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ keep: 20 });
    for (let i = 0; i < 25; i++) {
        sandbox.emit('MESSAGE_CREATE', created('c' + i, 'text ' + i));
        sandbox.emit('MESSAGE_DELETE', deleted('c' + i));
    }
    await tick();
    if (log().length !== 20) throw new Error('the cap did not hold: ' + log().length);
    if (log()[0].before !== 'text 24') throw new Error('the newest entry is not first: ' + log()[0].before);

    // ── Clearing ─────────────────────────────────────────────────────────────
    const clear = findRow(inst.SettingsComponent({ api: sandbox.api }), 'Clear the log');
    if (!clear) throw new Error('the page has no Clear the log row');
    clear.onPress();
    await tick();
    if (log().length !== 0) throw new Error('the log was not cleared: ' + log().length);
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Clear the log (0)')) throw new Error('the page still shows entries');

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    console.log('VERIFY OK: edits keep before/after, unchanged edits and unseen messages are skipped, deletions keep the text, cap holds, page lists and clears');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
