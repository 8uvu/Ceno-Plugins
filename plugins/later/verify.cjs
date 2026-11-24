// Verifies Later: a ping that came due fires on start and leaves the list, the
// menu offers the three delays and cancels what exists, the settings page lists
// what is waiting, switching the plugin off stops new pings, and stopping puts
// the menu back.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const CHANNEL = 'chan1';
const HOUR = 60 * 60 * 1000;

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
        if (typeof props.label === 'string' && /^(Ping me|Cancel the ping)/.test(props.label)) {
            out.push({ label: props.label, onPress: props.onPress });
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return out;
}

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
            UserStore: { getUser: (id) => ({ id, username: 'Ada' }) },
            ChannelStore: {
                getChannel: (id) => (id === CHANNEL ? { id, name: 'general', guild_id: 'g1' } : null),
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

    // A ping that came due while the app was closed, before the plugin starts.
    await sandbox.api.jsonStorage.set({
        pings: [
            {
                id: 'old:1h',
                messageId: 'm0',
                channelId: CHANNEL,
                channelName: '#general',
                authorName: 'Ada',
                preview: 'overdue',
                at: Date.now() - 5000,
                createdAt: Date.now() - HOUR,
            },
        ],
    });

    const inst = loadBundle('dev.8uvu.later', sandbox);
    await inst.start(sandbox.api);
    await tick();

    if (!sandbox.toasts.some((entry) => entry.startsWith('Ping: “overdue”'))) {
        throw new Error('the overdue ping did not fire on start: ' + JSON.stringify(sandbox.toasts));
    }
    if ((sandbox.stored.pings ?? []).length !== 0) throw new Error('the fired ping stayed in the list');

    // ── The menu ─────────────────────────────────────────────────────────────
    const sheetFor = () =>
        messageSheet.default({
            channel: { id: CHANNEL, type: 0, guild_id: 'g1' },
            message: {
                id: 'm1',
                channel_id: CHANNEL,
                content: 'look at this',
                author: { id: 'ada', username: 'Ada' },
            },
        });

    let rows = rowsOf(sheetFor());
    const labels = rows.map((row) => row.label);
    for (const expected of ['Ping me in 1 hour', 'Ping me in 3 hours', 'Ping me tomorrow']) {
        if (!labels.includes(expected)) throw new Error('the menu is missing: ' + expected + ' (has ' + labels.join(', ') + ')');
    }
    if (labels.some((label) => label.startsWith('Cancel the ping'))) {
        throw new Error('a cancel row appeared with nothing to cancel');
    }

    sandbox.toasts.length = 0;
    rows.find((row) => row.label === 'Ping me in 1 hour').onPress();
    await tick();
    const pings = sandbox.stored.pings ?? [];
    if (pings.length !== 1) throw new Error('the ping was not stored: ' + JSON.stringify(pings));
    const ping = pings[0];
    if (Math.abs(ping.at - (Date.now() + HOUR)) > 10000) throw new Error('the ping is not an hour away: ' + ping.at);
    if (ping.preview !== 'look at this') throw new Error('wrong preview: ' + ping.preview);
    if (ping.authorName !== 'Ada') throw new Error('wrong author: ' + ping.authorName);
    if (ping.channelName !== '#general') throw new Error('wrong channel: ' + ping.channelName);
    if (!sandbox.toasts.includes('Ping set for 1 hour.')) {
        throw new Error('no toast after setting a ping: ' + JSON.stringify(sandbox.toasts));
    }

    // Pressing the same row again replaces rather than duplicates.
    rowsOf(sheetFor()).find((row) => row.label === 'Ping me in 1 hour').onPress();
    await tick();
    if ((sandbox.stored.pings ?? []).length !== 1) throw new Error('the same ping was added twice');

    // ── The page ─────────────────────────────────────────────────────────────
    let text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['Later', 'Allow pings', 'Waiting (1)', 'look at this']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Cancelling from the menu ─────────────────────────────────────────────
    rows = rowsOf(sheetFor());
    const cancel = rows.find((row) => row.label === 'Cancel the ping for this message');
    if (!cancel) throw new Error('the cancel row did not appear for a message with a ping');
    cancel.onPress();
    await tick();
    if ((sandbox.stored.pings ?? []).length !== 0) throw new Error('the ping was not cancelled');
    if (!sandbox.toasts.includes('Ping cancelled.')) throw new Error('no toast after cancelling');

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.toasts.length = 0;
    rowsOf(sheetFor()).find((row) => row.label === 'Ping me tomorrow').onPress();
    await tick();
    if ((sandbox.stored.pings ?? []).length !== 0) throw new Error('a ping was set while switched off');
    if (!sandbox.toasts.includes('Later is switched off in its settings.')) {
        throw new Error('switched off was not explained: ' + JSON.stringify(sandbox.toasts));
    }
    await sandbox.api.jsonStorage.set({ enabled: true });

    // ── Cancel every ping from the page ──────────────────────────────────────
    rowsOf(sheetFor()).find((row) => row.label === 'Ping me in 3 hours').onPress();
    await tick();
    if ((sandbox.stored.pings ?? []).length !== 1) throw new Error('the ping was not set');
    const clear = findRow(inst.SettingsComponent({ api: sandbox.api }), 'Cancel every ping');
    if (!clear) throw new Error('the page has no cancel-all row');
    clear.onPress();
    await tick();
    if ((sandbox.stored.pings ?? []).length !== 0) throw new Error('cancel every ping left something behind');
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Nothing waiting')) throw new Error('the page still lists pings');

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (messageSheet.default !== originalDefault) {
        throw new Error('unpatch left the message menu replaced');
    }

    console.log('VERIFY OK: overdue ping fires on start, three delays offered, same row replaces, cancel from menu and page, switched off explained');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
