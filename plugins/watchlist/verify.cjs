// Verifies Watchlist: the long-press row watches and unwatches the author, a
// watched person's presence change, typing and message each produce one toast,
// the throttles hold, your own messages are ignored, and stopping puts the menu
// back.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const ME = 'me';
const ADA = 'ada';

// Discord's action sheet rows, which the default design stub leaves out.
function addSheetDesign(sandbox) {
    const D = sandbox.designStub;
    const element = (type, props) => ({ type, props: props ?? {}, children: props?.children });
    const ActionSheet = function ActionSheet(props) {
        return element(ActionSheet, props);
    };
    const Row = function ActionSheetRow(props) {
        return element(Row, props);
    };
    Row.Group = function ActionSheetRowGroup(props) {
        return element(Row.Group, props);
    };
    Row.Icon = function ActionSheetRowIcon(props) {
        return element(Row.Icon, props);
    };
    D.ActionSheet = ActionSheet;
    D.ActionSheetRow = Row;
    D.TableRowGroup = function TableRowGroup(props) {
        return element(D.TableRowGroup, props);
    };
    D.TableRow = function TableRow(props) {
        return element(D.TableRow, props);
    };
}

// The rows the plugin adds: Watch …, Stop watching …, or nothing.
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
        if (typeof props.label === 'string' && /^(Watch|Stop watching) /.test(props.label)) {
            out.push({ label: props.label, onPress: props.onPress });
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return out;
}

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: {
                getCurrentUser: () => ({ id: ME }),
                getUser: (id) => ({ id, username: id === ADA ? 'Ada' : id }),
            },
        },
    });
    addSheetDesign(sandbox);

    const messageSheet = {
        default: () => ({
            type: sandbox.designStub.ActionSheet,
            props: { children: [{ type: 'SheetHeader', props: { label: 'Message' } }] },
        }),
    };
    sandbox.provide(messageSheet, { name: 'LongPressMessageActionSheet' });
    const originalDefault = messageSheet.default;

    const inst = loadBundle('dev.8uvu.watchlist', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const sheetFor = (author) =>
        messageSheet.default({
            channel: { id: 'dm1', type: 1 },
            message: {
                id: 'm1',
                author: { id: author, username: author === ADA ? 'Ada' : author },
            },
        });

    // ── Watch and unwatch from the message menu ──────────────────────────────
    let rows = rowsOf(sheetFor(ADA));
    if (rows.length !== 1 || rows[0].label !== 'Watch Ada') {
        throw new Error('expected one "Watch Ada" row, got: ' + JSON.stringify(rows.map((row) => row.label)));
    }
    rows[0].onPress();
    await tick();
    if (!sandbox.stored.people?.[ADA]) throw new Error('the person was not added to the list');
    if (!sandbox.toasts.includes('Now watching Ada.')) {
        throw new Error('no toast after watching: ' + JSON.stringify(sandbox.toasts));
    }

    rows = rowsOf(sheetFor(ADA));
    if (rows[0]?.label !== 'Stop watching Ada') {
        throw new Error('the row did not turn into "Stop watching Ada": ' + JSON.stringify(rows.map((row) => row.label)));
    }

    // Your own messages never offer the row.
    if (rowsOf(sheetFor(ME)).length) throw new Error('your own message offered the row');

    // ── Presence, typing, messages ───────────────────────────────────────────
    sandbox.toasts.length = 0;
    sandbox.emit('PRESENCE_UPDATE', { user: { id: ADA }, status: 'offline' });
    await tick();
    if (sandbox.toasts.length) throw new Error('an offline update produced a toast');

    sandbox.emit('PRESENCE_UPDATE', { user: { id: ADA }, status: 'online' });
    await tick();
    if (!sandbox.toasts.includes('Ada is online.')) {
        throw new Error('no toast when the watched person came online: ' + JSON.stringify(sandbox.toasts));
    }
    sandbox.emit('PRESENCE_UPDATE', { user: { id: ADA }, status: 'online' });
    await tick();
    if (sandbox.toasts.length !== 1) {
        throw new Error('a repeated online update produced another toast: ' + JSON.stringify(sandbox.toasts));
    }

    sandbox.toasts.length = 0;
    sandbox.emit('TYPING_START', { userId: ADA, channelId: 'dm1' });
    await tick();
    if (!sandbox.toasts.includes('Ada is typing…')) {
        throw new Error('no toast when the watched person typed: ' + JSON.stringify(sandbox.toasts));
    }
    sandbox.emit('TYPING_START', { userId: ADA, channelId: 'dm1' });
    await tick();
    if (sandbox.toasts.length !== 1) throw new Error('typing was not throttled');

    sandbox.toasts.length = 0;
    sandbox.emit('MESSAGE_CREATE', { message: { id: 'm9', author: { id: ADA }, content: 'hi' } });
    await tick();
    if (!sandbox.toasts.includes('Ada sent a message.')) {
        throw new Error('no toast when the watched person sent a message: ' + JSON.stringify(sandbox.toasts));
    }
    sandbox.emit('MESSAGE_CREATE', { message: { id: 'm10', author: { id: ME }, content: 'me' } });
    await tick();
    if (sandbox.toasts.length !== 1) throw new Error('your own message produced a toast');

    // An unwatched person is ignored entirely.
    sandbox.toasts.length = 0;
    sandbox.emit('TYPING_START', { userId: 'stranger', channelId: 'dm1' });
    sandbox.emit('MESSAGE_CREATE', { message: { id: 'm11', author: { id: 'stranger' }, content: 'x' } });
    await tick();
    if (sandbox.toasts.length) throw new Error('an unwatched person produced a toast');

    // ── The settings page ────────────────────────────────────────────────────
    let text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['Watchlist', 'Watching (1)', 'Ada', 'When they start typing']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Stop watching ────────────────────────────────────────────────────────
    rows = rowsOf(sheetFor(ADA));
    rows[0].onPress();
    await tick();
    if (sandbox.stored.people?.[ADA]) throw new Error('the person was not removed');
    if (!sandbox.toasts.includes('Stopped watching Ada.')) {
        throw new Error('no toast after unwatching: ' + JSON.stringify(sandbox.toasts));
    }
    sandbox.toasts.length = 0;
    sandbox.emit('TYPING_START', { userId: ADA, channelId: 'dm1' });
    await tick();
    if (sandbox.toasts.length) throw new Error('an unwatched person still produced a toast');

    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Watching (0)')) throw new Error('the page still lists a person');

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (messageSheet.default !== originalDefault) {
        throw new Error('unpatch left the message menu replaced');
    }

    console.log('VERIFY OK: watch/unwatch from the menu, presence, typing and message toasts, throttles, own messages ignored, page renders');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
