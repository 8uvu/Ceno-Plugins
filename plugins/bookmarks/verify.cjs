// Verifies Bookmarks: the long-press row saves and unsaves a message, the saved
// text, author and channel are kept, the page lists what is saved and asks
// before removing one, clearing works, switching the plugin off takes the row
// away, and stopping puts the menu back.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const CHANNEL = 'chan1';
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

// Every labelled element in a tree, with the props a verifier needs.
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
        if (typeof props.label === 'string') {
            out.push({ label: props.label, subLabel: props.subLabel, onPress: props.onPress });
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return out;
}

const menuLabels = (tree) =>
    rowsOf(tree)
        .map((row) => row.label)
        .filter((label) => label === 'Save this message' || label === 'Remove this bookmark');

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: { getUser: (id) => ({ id, username: id === ADA ? 'Ada' : id }) },
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

    const inst = loadBundle('dev.8uvu.bookmarks', sandbox);
    await inst.start(sandbox.api);
    await tick();

    const sheetFor = (id = 'm1', content = 'look at this') =>
        messageSheet.default({
            channel: { id: CHANNEL, type: 0, guild_id: 'g1' },
            message: {
                id,
                channel_id: CHANNEL,
                content,
                author: { id: ADA, username: 'Ada' },
            },
        });

    // ── Saving from the menu ─────────────────────────────────────────────────
    let save = rowsOf(sheetFor()).find((row) => row.label === 'Save this message');
    if (!save) throw new Error('the message menu has no save row: ' + JSON.stringify(menuLabels(sheetFor())));
    save.onPress();
    await tick();

    let items = sandbox.stored.items ?? [];
    if (items.length !== 1) throw new Error('the message was not saved: ' + JSON.stringify(items));
    const item = items[0];
    if (item.id !== 'm1') throw new Error('wrong id: ' + item.id);
    if (item.content !== 'look at this') throw new Error('wrong text: ' + item.content);
    if (item.authorName !== 'Ada') throw new Error('wrong author: ' + item.authorName);
    if (item.channelName !== '#general') throw new Error('wrong channel: ' + item.channelName);
    if (!sandbox.toasts.includes('Saved to bookmarks.')) {
        throw new Error('no toast after saving: ' + JSON.stringify(sandbox.toasts));
    }
    if (!menuLabels(sheetFor()).includes('Remove this bookmark')) {
        throw new Error('the row did not turn into Remove this bookmark: ' + JSON.stringify(menuLabels(sheetFor())));
    }

    // Pressing the same row again removes it.
    rowsOf(sheetFor())
        .find((row) => row.label === 'Remove this bookmark')
        .onPress();
    await tick();
    if ((sandbox.stored.items ?? []).length !== 0) throw new Error('the bookmark was not removed');
    if (!sandbox.toasts.includes('Removed from bookmarks.')) {
        throw new Error('no toast after removing: ' + JSON.stringify(sandbox.toasts));
    }

    // ── Two saved, then the page ─────────────────────────────────────────────
    rowsOf(sheetFor('m1', 'look at this')).find((row) => row.label === 'Save this message').onPress();
    await tick();
    rowsOf(sheetFor('m2', 'and this')).find((row) => row.label === 'Save this message').onPress();
    await tick();
    if ((sandbox.stored.items ?? []).length !== 2) throw new Error('the second message was not saved');
    if ((sandbox.stored.items ?? [])[0].id !== 'm2') throw new Error('the newest save is not first');

    const page = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(page);
    for (const expected of ['Bookmarks', 'Saved (2)', 'look at this', 'Ada · #general', 'Remove every bookmark (2)']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Removing one from the page asks first ────────────────────────────────
    const savedRow = rowsOf(page).find(
        (row) => typeof row.subLabel === 'string' && row.subLabel.includes('look at this'),
    );
    if (!savedRow?.onPress) throw new Error('the saved row cannot be tapped');
    savedRow.onPress();
    if (sandbox.alerts.length !== 1) throw new Error('tapping a bookmark did not ask first');
    sandbox.tapAlert('Cancel');
    await tick();
    if ((sandbox.stored.items ?? []).length !== 2) throw new Error('Cancel removed the bookmark');
    savedRow.onPress();
    sandbox.tapAlert('Remove');
    await tick();
    items = sandbox.stored.items ?? [];
    if (items.length !== 1 || items[0].id !== 'm2') {
        throw new Error('Remove did not take the right bookmark: ' + JSON.stringify(items));
    }

    // ── Clearing the list ────────────────────────────────────────────────────
    const clear = rowsOf(inst.SettingsComponent({ api: sandbox.api })).find((row) =>
        row.label.startsWith('Remove every bookmark'),
    );
    if (!clear) throw new Error('the page has no clear-all row');
    clear.onPress();
    await tick();
    if ((sandbox.stored.items ?? []).length !== 0) throw new Error('clear-all left something behind');
    if (!textOf(inst.SettingsComponent({ api: sandbox.api })).includes('Nothing saved yet')) {
        throw new Error('the page still lists bookmarks');
    }

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    if (menuLabels(sheetFor()).length) {
        throw new Error('the row is still offered while switched off: ' + JSON.stringify(menuLabels(sheetFor())));
    }
    await sandbox.api.jsonStorage.set({ enabled: true });
    if (!menuLabels(sheetFor()).includes('Save this message')) {
        throw new Error('the row did not come back when switched on again');
    }

    // ── Stop ─────────────────────────────────────────────────────────────────
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (messageSheet.default !== originalDefault) {
        throw new Error('unpatch left the message menu replaced');
    }

    console.log('VERIFY OK: save and unsave from the menu, text/author/channel kept, page lists and confirms removal, clear-all, switched off hides the row');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
