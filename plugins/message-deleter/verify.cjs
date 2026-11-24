// Verifies Message Deleter: the long-press rows appear where they should, the
// sheet closes before the confirmation, one delete goes through Discord's own
// action, a rate limit is waited out once and a 404 is reported as gone, and the
// bulk run walks pages newest-first touching only this account's messages.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The plugin waits 250 ms after the sheet closes before showing the alert.
const CONFIRM_WAIT = 450;
const RUN_WAIT = 20000;

const ME = 'me';
const DM = 'dm1';
const GUILD = 'guild1';

// Discord's action sheet and its rows, which the default harness does not stub.
function addSheetDesign(sandbox) {
    const D = sandbox.designStub;
    // `children` is mirrored onto the element so textOf can walk it; the sheet
    // patch appends rows to `props.children`, which rowsOf reads.
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

    // The settings page checks for functions, as the real client has; the
    // default stub hands out strings.
    D.TableRowGroup = function TableRowGroup(props) {
        return element(D.TableRowGroup, props);
    };
    D.TableRow = function TableRow(props) {
        return element(D.TableRow, props);
    };
}

// Every row the plugin adds to a rendered sheet, with the handler a tap would
// call. Its rows are the destructive ones; the sheet's own header is ignored.
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
        if (typeof props.label === 'string' && props.variant === 'danger') {
            out.push({ label: props.label, onPress: props.onPress });
        }
        walk(props.children);
        walk(node.children);
    };
    walk(tree);
    return out;
}

const message = (id, author) => ({ id, content: 'text ' + id, author: { id: author } });

async function main() {
    const deleted = [];
    let failNext = null;
    const pages = new Map();

    const sandbox = createSandbox({
        stores: { UserStore: { getCurrentUser: () => ({ id: ME }) } },
    });
    addSheetDesign(sandbox);

    // The message long-press menu, found by component name like the client does.
    const messageSheet = {
        default: () => ({
            type: sandbox.designStub.ActionSheet,
            props: { children: [{ type: 'SheetHeader', props: { label: 'Message' } }] },
        }),
    };
    sandbox.provide(messageSheet, { name: 'LongPressMessageActionSheet' });

    // The chat long-press menu: a wrapper element around the connected sheet.
    const Inner = function ChannelLongPressActionSheetConnected() {
        return { type: sandbox.designStub.ActionSheet, props: { children: [] } };
    };
    const channelSheet = { default: (props) => ({ type: Inner, props }) };
    sandbox.provide(channelSheet, { name: 'ChannelLongPressActionSheet' });

    sandbox.provide(
        {
            sendMessage() {},
            deleteMessage(channelId, messageId) {
                deleted.push({ channelId, messageId });
                if (failNext) {
                    const error = failNext;
                    failNext = null;
                    throw error;
                }
            },
        },
        { provides: ['deleteMessage', 'sendMessage'] },
    );

    const http = {
        async get({ url }) {
            const before = /before=([^&]*)/.exec(url)?.[1] ?? '';
            return { body: pages.get(before) ?? [] };
        },
    };
    sandbox.provide({ HTTP: http }, { provides: ['HTTP'] });

    const originalMessageDefault = messageSheet.default;
    const inst = loadBundle('dev.8uvu.dm-deleter', sandbox);
    await inst.start(sandbox.api);
    await tick();

    // ── Where the rows appear ────────────────────────────────────────────────
    let rows = rowsOf(messageSheet.default({ channel: { id: GUILD, type: 0, guild_id: 'g1' }, message: message('m1', ME) }));
    if (!rows.some((row) => row.label === 'Delete this message')) {
        throw new Error('a guild channel lost the single delete row');
    }
    if (rows.some((row) => row.label === 'Delete all my messages')) {
        throw new Error('the bulk row was offered in a guild channel');
    }

    rows = rowsOf(messageSheet.default({ channel: { id: GUILD, type: 0, guild_id: 'g1' }, message: message('m2', 'friend') }));
    if (rows.length) {
        throw new Error("rows were added to another person's message in a guild: " + JSON.stringify(rows.map((row) => row.label)));
    }

    rows = rowsOf(messageSheet.default({ channel: { id: DM, type: 1 }, message: message('m2', 'friend') }));
    if (rows.some((row) => row.label === 'Delete this message')) {
        throw new Error("another person's message offered a delete");
    }
    if (!rows.some((row) => row.label === 'Delete all my messages')) {
        throw new Error('the bulk row is missing from a DM');
    }

    rows = rowsOf(messageSheet.default({ channel: { id: DM, type: 1 }, message: message('m1', ME) }));
    for (const label of ['Delete this message', 'Delete all my messages']) {
        if (!rows.some((row) => row.label === label)) throw new Error('DM is missing the row: ' + label);
    }

    // ── One message ──────────────────────────────────────────────────────────
    const deleteOne = rows.find((row) => row.label === 'Delete this message');
    sandbox.actionSheets.length = 0;
    sandbox.alerts.length = 0;
    sandbox.toasts.length = 0;
    deleteOne.onPress();
    if (!sandbox.actionSheets.some((entry) => entry.closed)) {
        throw new Error('the sheet was not closed before the confirmation');
    }
    if (sandbox.alerts.length) throw new Error('the confirmation was drawn under the sheet');
    await wait(CONFIRM_WAIT);
    if (!sandbox.alerts.length) throw new Error('no confirmation was shown');
    sandbox.tapAlert('Delete');
    await tick();
    if (deleted.length !== 1 || deleted[0].messageId !== 'm1' || deleted[0].channelId !== DM) {
        throw new Error('the wrong message was deleted: ' + JSON.stringify(deleted));
    }
    if (!sandbox.toasts.includes('Message deleted.')) {
        throw new Error('no success toast: ' + JSON.stringify(sandbox.toasts));
    }

    // A 429 is waited out for the delay Discord names, then retried once.
    deleted.length = 0;
    failNext = { status: 429, body: { retry_after: 0.05 } };
    rowsOf(messageSheet.default({ channel: { id: DM, type: 1 }, message: message('m3', ME) }))
        .find((row) => row.label === 'Delete this message')
        .onPress();
    await wait(CONFIRM_WAIT);
    sandbox.tapAlert('Delete');
    await wait(700);
    if (deleted.length !== 2) throw new Error('a rate-limited delete was not retried once: ' + JSON.stringify(deleted));
    if (!sandbox.toasts.includes('Message deleted.')) throw new Error('the retried delete reported no success');

    // A message that is already gone reads as gone, not as a failure.
    deleted.length = 0;
    sandbox.toasts.length = 0;
    failNext = new Error('404: Unknown Message');
    rowsOf(messageSheet.default({ channel: { id: DM, type: 1 }, message: message('m4', ME) }))
        .find((row) => row.label === 'Delete this message')
        .onPress();
    await wait(CONFIRM_WAIT);
    sandbox.tapAlert('Delete');
    await tick();
    if (!sandbox.toasts.includes('That message was already gone.')) {
        throw new Error('a missing message was not reported as gone: ' + JSON.stringify(sandbox.toasts));
    }

    // ── Every message of mine ────────────────────────────────────────────────
    // A full first page and a short second one, so the walk has to page.
    const page1 = [];
    for (let id = 149; id >= 100; id--) {
        page1.push(message(String(id), id === 149 || id === 120 ? ME : 'friend'));
    }
    pages.set('', page1);
    const page2 = [];
    for (let id = 99; id >= 95; id--) page2.push(message(String(id), id === 99 ? ME : 'friend'));
    pages.set('100', page2);

    deleted.length = 0;
    sandbox.toasts.length = 0;
    rowsOf(messageSheet.default({ channel: { id: DM, type: 1 }, message: message('m2', 'friend') }))
        .find((row) => row.label === 'Delete all my messages')
        .onPress();
    await wait(CONFIRM_WAIT);
    sandbox.tapAlert('Delete all');

    const started = Date.now();
    while (Date.now() - started < RUN_WAIT) {
        if (sandbox.toasts.some((entry) => /messages? deleted\./.test(entry))) break;
        await wait(100);
    }

    const order = deleted.map((entry) => entry.messageId);
    if (order.join(',') !== '149,120,99') {
        throw new Error('wrong messages deleted, or not newest-first: ' + order.join(','));
    }
    if (deleted.some((entry) => entry.channelId !== DM)) {
        throw new Error('a delete went to the wrong channel: ' + JSON.stringify(deleted));
    }
    if (!sandbox.toasts.includes('3 messages deleted.')) {
        throw new Error('the run reported the wrong total: ' + JSON.stringify(sandbox.toasts));
    }

    // ── The chat menu ────────────────────────────────────────────────────────
    const channelRows = rowsOf(channelSheet.default({ channel: { id: DM, type: 1 }, onClose() {} }));
    if (!channelRows.some((row) => row.label === 'Delete all my messages')) {
        throw new Error('the chat menu is missing the bulk row');
    }
    const guildRows = rowsOf(channelSheet.default({ channel: { id: GUILD, type: 0, guild_id: 'g1' }, onClose() {} }));
    if (guildRows.length) throw new Error('the chat menu added rows to a guild channel');

    // ── The settings page ────────────────────────────────────────────────────
    const text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of [
        'Message Deleter',
        'Delete all your messages',
        'Diagnostics',
        'Ready. The rows are in the long-press menu.',
        '3 messages deleted.',
    ]) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    if (messageSheet.default !== originalMessageDefault) {
        throw new Error('unpatch left the message menu replaced');
    }

    console.log(
        'VERIFY OK: rows in DMs only, sheet closes before the alert, single delete, 429 waited out once, 404 reads as gone, bulk pages newest-first',
    );
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
