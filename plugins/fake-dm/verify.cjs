// Verifies FakeDM: fake messages/calls reach Flux, clear removes them, the
// settings page renders, and the chat bar gets Discord's own action button.
const { collect, createSandbox, loadBundle, textOf } = require('../../scripts/valenced-harness.cjs');

const CHAT = 'dm1';
const OTHER = { id: 'other', username: 'friend', globalName: 'Friend' };
const BUTTON_PATH = 'modules/chat_input/native/action_buttons/ChatInputActionButton.tsx';
const INPUT_PATH = 'modules/chat_input/native/ChatInput.tsx';

// Discord's chat input: an object whose `type` render function the patcher wraps.
function makeChatInput(tree) {
    return {
        type: () => tree(),
    };
}

function makeSandbox({ chatTree = defaultTree } = {}) {
    const dispatched = [];
    const sandbox = createSandbox({ strictNative: true });
    sandbox.provide({ dispatch: (event) => dispatched.push(event), subscribe: () => () => {} }, {
        provides: ['dispatch', 'subscribe'],
    });
    sandbox.provide({ getChannelId: () => CHAT }, { provides: ['getChannelId'] });
    sandbox.provide({ getChannel: (id) => ({ id, recipients: [OTHER] }) }, { provides: ['getChannel'] });
    sandbox.provide({ getCurrentUser: () => ({ id: 'me', username: 'me' }) }, { provides: ['getCurrentUser'] });

    // Renders an element, the way Discord's real button component does.
    function ActionButton(props) {
        return { type: ActionButton, props, children: props?.children };
    }
    sandbox.provide({ default: ActionButton }, { path: BUTTON_PATH });
    sandbox.chatInput = makeChatInput(chatTree);
    sandbox.provide({ default: sandbox.chatInput }, { path: INPUT_PATH });
    sandbox.ActionButton = ActionButton;
    sandbox.dispatched = dispatched;
    return sandbox;
}

// The chat input's tree: a button group holding one of Discord's own buttons.
function defaultTree() {
    const own = { type: 'OwnButton', props: { onPressExpression: 'emoji' }, children: undefined };
    const group = { type: 'Group', props: { children: own }, children: own };
    return { type: 'ChatInput', props: { children: [group] }, children: [group] };
}

async function main() {
    const sandbox = makeSandbox();
    // Both extras are opt-in; the settings switches are what turn them on.
    await sandbox.api.jsonStorage.set({ button: true, section: true });
    const inst = loadBundle('dev.8uvu.fake-dm', sandbox);
    await inst.start(sandbox.api);
    const engine = inst.__engine;
    if (!engine) throw new Error('plugin did not expose its engine');

    // ── The engine ───────────────────────────────────────────────────────────
    const id = engine.fakeMessage(CHAT, OTHER, 'hello there');
    if (!id) throw new Error('fakeMessage returned nothing');
    const created = sandbox.dispatched.find((e) => e.type === 'MESSAGE_CREATE' && e.message?.id === id);
    if (!created) throw new Error('MESSAGE_CREATE was not dispatched');
    const message = created.message;
    if (message.type !== 0) throw new Error('message type is ' + message.type);
    if (message.content !== 'hello there') throw new Error('wrong content: ' + message.content);
    if (message.channel_id !== CHAT) throw new Error('wrong channel on the message');
    if (message.author.id !== OTHER.id) throw new Error('wrong author: ' + message.author.id);
    if (Number.isNaN(Date.parse(message.timestamp))) throw new Error('no valid timestamp');
    if (!Array.isArray(message.attachments) || !Array.isArray(message.embeds)) {
        throw new Error('message is missing the arrays Discord renders from');
    }

    const callId = engine.fakeCall(CHAT, OTHER, { id: 'me', username: 'me' }, 90);
    const call = sandbox.dispatched.find((e) => e.type === 'MESSAGE_CREATE' && e.message?.id === callId);
    if (!call) throw new Error('the call was not dispatched');
    if (call.message.type !== 3) throw new Error('call type is ' + call.message.type);
    if (call.message.call.duration !== 90) throw new Error('call duration wrong');
    const participants = call.message.call.participants.join(',');
    if (participants !== 'other,me') throw new Error('call participants wrong: ' + participants);

    if ((sandbox.stored.fakes ?? []).length !== 2) throw new Error('fakes were not remembered');

    const removed = engine.clear(CHAT);
    if (removed !== 2) throw new Error('clear removed ' + removed);
    for (const removedId of [id, callId]) {
        if (!sandbox.dispatched.some((e) => e.type === 'MESSAGE_DELETE' && e.id === removedId)) {
            throw new Error('clear did not MESSAGE_DELETE ' + removedId);
        }
    }
    if ((sandbox.stored.fakes ?? []).length !== 0) throw new Error('fakes were not forgotten');

    // ── The chat bar button ──────────────────────────────────────────────────
    // It is Discord's own ChatInputActionButton, put into the button group.
    if (sandbox.chatInput.type === undefined) throw new Error('chat input was not patched');
    const tree = sandbox.chatInput.type();
    if (!tree?.props?.children) throw new Error('chat input rendered nothing');
    const kids = tree.props.children;
    if (!Array.isArray(kids) || kids.length !== 2) {
        throw new Error('expected the button plus the original group, got ' + JSON.stringify(kids?.length));
    }
    const button = kids[0];
    if (button.type !== sandbox.ActionButton) {
        throw new Error("chat bar: the button is not Discord's own action button");
    }
    if (button.props.accessibilityLabel !== 'FakeDM') throw new Error('chat bar: wrong label');
    if (typeof button.props.IconComponent !== 'function') throw new Error('chat bar: no icon component');
    if (kids[1].type !== 'Group') throw new Error('chat bar: the original buttons moved or vanished');

    // Pressing it sends the configured text as the other person.
    const before = sandbox.dispatched.length;
    button.props.onPress();
    const sent = sandbox.dispatched.slice(before).find((e) => e.type === 'MESSAGE_CREATE');
    if (!sent) throw new Error('chat bar: pressing the button sent nothing');
    if (sent.message.content !== 'hello') throw new Error('chat bar: wrong text: ' + sent.message.content);
    if (sent.message.author.id !== OTHER.id) throw new Error('chat bar: wrong sender');

    // A second render must not add a second button.
    const again = sandbox.chatInput.type();
    if (again.props.children.length !== 2) throw new Error('chat bar: button duplicated');

    // ── Settings page (the panel) ────────────────────────────────────────────
    const ui = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(ui);
    for (const expected of [
        'Chat',
        'Send as',
        'Friend',
        'You',
        'Sending as them',
        'Message',
        'Send as Friend',
        'Clear fakes',
        'Fake button in chat bar',
        'Find my chat',
    ]) {
        if (!text.includes(expected)) throw new Error('settings page missing: ' + expected);
    }

    const settingsBefore = sandbox.dispatched.length;
    const press = collect(ui).find(
        (n) => n?.props?.label === 'Send as Friend' && typeof n.props.onPress === 'function',
    );
    if (!press) throw new Error('no send button on the page');
    press.props.onPress();
    if (sandbox.dispatched.length <= settingsBefore) throw new Error('the settings button sent nothing');

    // Tapping a person makes them the sender, and the button says so. People are
    // Discord's radio rows, so the choice goes through the group's onChange.
    const sendAs = collect(ui).find((n) => n?.props?.title === 'Send as' && typeof n.props.onChange === 'function');
    if (!sendAs) throw new Error('no "Send as" picker on the page');
    const myRow = collect(ui).find((n) => n?.props?.label === 'You' && n?.props?.value === 'me');
    if (!myRow) throw new Error('no "You" row to pick as sender');
    sendAs.props.onChange('me');
    const afterPick = inst.SettingsComponent({ api: sandbox.api });
    const sendAsMe = collect(afterPick).find(
        (n) => n?.props?.label === 'Send as You' && typeof n.props.onPress === 'function',
    );
    if (!sendAsMe) throw new Error('the button did not follow the chosen sender');
    const beforeMe = sandbox.dispatched.length;
    sendAsMe.props.onPress();
    const mine = sandbox.dispatched.slice(beforeMe).find((e) => e.type === 'MESSAGE_CREATE');
    if (!mine || mine.message.author.id !== 'me') {
        throw new Error('choosing a sender did not change the author: ' + mine?.message?.author?.id);
    }

    // The panel is split into categories, like the desktop plugin's tabs.
    const CAT_KEY = {
        Message: 'message',
        Call: 'call',
        Batch: 'batch',
        System: 'system',
        Reaction: 'reaction',
        Diagnostics: 'diag',
    };
    const openCat = (label) => {
        const current = inst.SettingsComponent({ api: sandbox.api });
        const picker = collect(current).find((n) => n?.props?.title === 'What to send' && typeof n.props.onChange === 'function');
        if (!picker) throw new Error('no "What to send" picker');
        const row = collect(current).find((n) => n?.props?.label === label && n?.props?.value === CAT_KEY[label]);
        if (!row) throw new Error('no ' + label + ' choice in the picker');
        picker.props.onChange(CAT_KEY[label]);
        return inst.SettingsComponent({ api: sandbox.api });
    };

    const callPage = textOf(openCat('Call'));
    for (const expected of ['Caller', 'Receiver', 'Send fake call', 'Send missed call']) {
        if (!callPage.includes(expected)) throw new Error('call category missing: ' + expected);
    }
    const sysPage = textOf(openCat('System'));
    for (const expected of ['Send system message', 'Pinned a message', 'New member joined']) {
        if (!sysPage.includes(expected)) throw new Error('system category missing: ' + expected);
    }
    const reactPage = textOf(openCat('Reaction'));
    for (const expected of ['Add reaction', 'Who reacts']) {
        if (!reactPage.includes(expected)) throw new Error('reaction category missing: ' + expected);
    }

    // The diagnostics tab reports the lookups on the device itself.
    const diagText = textOf(openCat('Diagnostics'));
    for (const expected of [
        'Diagnostics',
        'Installed version',
        'Chat found',
        'Chat id',
        'dm1',
        'People it can see',
        'Chat bar button module',
        'Chat input module',
        'Discord dispatcher',
    ]) {
        if (!diagText.includes(expected)) throw new Error('diagnostics missing: ' + expected);
    }
    if (!diagText.includes('found (path)')) throw new Error('diagnostics does not say how a module was found');

    // A batch goes out as the names on its lines, spaced out in time.
    const batchPage = openCat('Batch');
    if (!textOf(batchPage).includes('Send batch')) throw new Error('batch category missing its send button');
    const batchBox = collect(batchPage).find((n) => String(n?.props?.placeholder ?? '').includes('Alice'));
    if (!batchBox) throw new Error('no batch box on the page');
    batchBox.props.onChangeText('Friend: first\nsecond line');
    const beforeBatch = sandbox.dispatched.length;
    const batchSend = collect(batchPage).find(
        (n) => n?.props?.label === 'Send batch' && typeof n.props.onPress === 'function',
    );
    if (!batchSend) throw new Error('no "Send batch" row on the page');
    batchSend.props.onPress();
    const batched = sandbox.dispatched.slice(beforeBatch).filter((e) => e.type === 'MESSAGE_CREATE');
    if (batched.length !== 2) throw new Error('batch sent ' + batched.length + ' message(s), expected 2');
    if (batched[0].message.author.id !== OTHER.id) throw new Error('batch ignored the name on the line');
    if (batched[1].message.content !== 'second line') throw new Error('batch lost the plain line');
    if (Date.parse(batched[1].message.timestamp) <= Date.parse(batched[0].message.timestamp)) {
        throw new Error('batch messages have no spacing');
    }

    const parsed = engine.parseBatch('Alice: hi\n\nhi back');
    if (parsed.length !== 2 || parsed[0].name !== 'Alice' || parsed[1].content !== 'hi back') {
        throw new Error('batch parse wrong: ' + JSON.stringify(parsed));
    }

    // A [HH:MM] in front of a batch line sets that line's time.
    const timed = engine.parseBatch('[14:30] Alice: hi');
    if (timed.length !== 1 || timed[0].name !== 'Alice' || timed[0].content !== 'hi') {
        throw new Error('batch ignored the [HH:MM] tag: ' + JSON.stringify(timed));
    }
    if (!timed[0].time) throw new Error('batch dropped the time on a tagged line');

    // ── The rest of the panel: picture, reply, embed, system, reaction ───────
    const richId = engine.fakeMessage(CHAT, OTHER, 'look at this', undefined, {
        imageUrl: 'https://example.com/a.png',
        replyToId: '1234',
        embeds: [{ title: 'A title' }],
    });
    const rich = sandbox.dispatched.find((e) => e.type === 'MESSAGE_CREATE' && e.message?.id === richId)?.message;
    if (!rich) throw new Error('a message with extras was not dispatched');
    if (rich.attachments?.[0]?.url !== 'https://example.com/a.png') throw new Error('the picture was dropped');
    if (rich.message_reference?.message_id !== '1234') throw new Error('the reply was dropped');
    if (rich.embeds?.[0]?.title !== 'A title') throw new Error('the embed was dropped');

    const sysId = engine.fakeSystem(CHAT, OTHER, 7, '');
    const sys = sandbox.dispatched.find((e) => e.type === 'MESSAGE_CREATE' && e.message?.id === sysId)?.message;
    if (!sys) throw new Error('the system message was not dispatched');
    if (sys.type !== 7) throw new Error('system message type is ' + sys.type);
    if (sys.author.id !== OTHER.id) throw new Error('system message has the wrong author');

    const reacted = engine.fakeReaction(CHAT, '1234', OTHER.id, '👍');
    if (!reacted) throw new Error('the reaction was refused');
    const reaction = sandbox.dispatched.find((e) => e.type === 'MESSAGE_REACTION_ADD');
    if (!reaction) throw new Error('MESSAGE_REACTION_ADD was not dispatched');
    if (reaction.messageId !== '1234' || reaction.userId !== OTHER.id) {
        throw new Error('the reaction went to the wrong place');
    }
    if (reaction.emoji?.name !== '👍') throw new Error('the reaction has the wrong emoji');


    // Back to the first category for the screen checks below.
    openCat('Message');

    if (sandbox.settings.errors.length) throw new Error('settings registration threw: ' + sandbox.settings.errors[0]);
    if (sandbox.settings.sections.length !== 1) throw new Error('expected one settings section');
    const item = sandbox.settings.items[0];
    if (!item || item.key !== 'FAKEDM_MAIN') throw new Error('settings item was not registered');
    // Clearing the hand-picked sender falls back to the other person, which is
    // what the settings entry renders before anyone chooses.
    const clearPick = collect(inst.SettingsComponent({ api: sandbox.api })).find(
        (n) => n?.props?.title === 'Send as' && typeof n.props.onChange === 'function',
    );
    if (!clearPick) throw new Error('no "Send as" picker to clear');
    clearPick.props.onChange('');

    const screen = item.config?.screen?.getComponent?.();
    const screenText = textOf(screen({}));
    for (const expected of ['Send as', 'Send as Friend', 'Clear fakes']) {
        if (!screenText.includes(expected)) throw new Error('settings screen missing: ' + expected);
    }

    // The section row is opt-in too, and off by default: adding a row to
    // Discord's own settings list is what crashed normal Settings on 352.6.
    const plain = makeSandbox();
    const plainInst = loadBundle('dev.8uvu.fake-dm', plain);
    await plainInst.start(plain.api);
    if (plain.settings.sections.length || plain.settings.items.length) {
        throw new Error('a settings row was registered while the section is switched off');
    }
    const plainText = textOf(plainInst.SettingsComponent({ api: plain.api }));
    for (const expected of ['Send as', 'Fake button in chat bar', 'Clear fakes']) {
        if (!plainText.includes(expected)) throw new Error('settings page broke without the section: ' + expected);
    }

    // Restarting re-patches the chat input.
    const patchedBefore = sandbox.chatInput.type;
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    sandbox.cleanups.length = 0;
    await inst.start(sandbox.api);
    if (sandbox.chatInput.type === patchedBefore) throw new Error('restart did not re-patch the chat input');
    if (sandbox.chatInput.type().props.children.length !== 2) throw new Error('restart lost the button');

    // Switched off: the chat input renders untouched.
    const offBox = makeSandbox();
    await offBox.api.jsonStorage.set({ button: false });
    const offInst = loadBundle('dev.8uvu.fake-dm', offBox);
    await offInst.start(offBox.api);
    const offTree = offBox.chatInput.type();
    if (offTree.props.children.length !== 1) throw new Error('chat bar: button shown while switched off');

    // A fresh install shows the button straight away, without hunting for the switch.
    const freshBox = makeSandbox();
    const freshInst = loadBundle('dev.8uvu.fake-dm', freshBox);
    await freshInst.start(freshBox.api);
    const freshTree = freshBox.chatInput.type();
    if (!Array.isArray(freshTree.props.children) || freshTree.props.children.length !== 2) {
        throw new Error('a fresh install did not put the button in the chat bar');
    }
    // ...and a choice made by hand is never overridden by that one-time switch-on.
    const chosenOff = makeSandbox();
    await chosenOff.api.jsonStorage.set({ button: false });
    const keptOff = loadBundle('dev.8uvu.fake-dm', chosenOff);
    await keptOff.start(chosenOff.api);
    const keptTree = chosenOff.chatInput.type();
    if (!Array.isArray(keptTree.props.children) || keptTree.props.children.length !== 1) {
        throw new Error('turning the button off was ignored on restart');
    }
    if (chosenOff.stored.button !== false) throw new Error('the off choice was overwritten in storage');

    // A host that reports no open chat at all: a typed channel id is enough.
    const blindBox = createSandbox({ strictNative: true });
    const blindEvents = [];
    blindBox.provide({ dispatch: (event) => blindEvents.push(event), subscribe: () => () => {} }, {
        provides: ['dispatch', 'subscribe'],
    });
    await blindBox.api.jsonStorage.set({ chatId: 'typed1', button: false });
    const blindInst = loadBundle('dev.8uvu.fake-dm', blindBox);
    await blindInst.start(blindBox.api);
    const typedChat = blindInst.__engine.openChat();
    if (!typedChat || typedChat.id !== 'typed1') throw new Error('a typed channel id did not find the chat');
    if (!blindInst.__engine.fakeMessage('typed1', OTHER, 'typed')) throw new Error('a typed chat could not be written to');

    // ── Tapping a chat is enough: no lookup, no button ──────────────────────
    const tapBox = createSandbox({ strictNative: true });
    const tapEvents = [];
    const subscriptions = new Map();
    tapBox.provide(
        {
            dispatch: (event) => tapEvents.push(event),
            subscribe: (event, handler) => {
                subscriptions.set(event, handler);
                return () => subscriptions.delete(event);
            },
        },
        { provides: ['dispatch', 'subscribe'] },
    );
    // A server channel with a member list, so "works everywhere" is covered too.
    tapBox.provide({ getChannel: (id) => ({ id, name: 'general', guild_id: 'g1' }) }, { provides: ['getChannel'] });
    tapBox.provide({ getUser: (id) => ({ id, username: id }) }, { provides: ['getUser'] });
    tapBox.provide({ getMembers: () => ({ m1: { userId: 'other' } }) }, { provides: ['getMembers'] });
    tapBox.provide({ getCurrentUser: () => ({ id: 'me', username: 'me' }) }, { provides: ['getCurrentUser'] });
    await tapBox.api.jsonStorage.set({ button: false });
    const tapInst = loadBundle('dev.8uvu.fake-dm', tapBox);
    await tapInst.start(tapBox.api);

    if (!subscriptions.has('CHANNEL_SELECT')) throw new Error('the plugin does not watch chat selection');
    subscriptions.get('CHANNEL_SELECT')({ channelId: 'tapped1' });
    const tapped = tapInst.__engine.openChat();
    if (!tapped || tapped.id !== 'tapped1') throw new Error('tapping a chat did not select it: ' + tapped?.id);
    if (!tapped.members.some((u) => u.id === 'other')) throw new Error('server members were not picked up');
    const tapText = textOf(tapInst.SettingsComponent({ api: tapBox.api }));
    if (!tapText.includes('general')) throw new Error('a server channel name is not shown');
    if (!tapText.includes('other')) throw new Error('a server member is missing from the people list');

    // ── Choosing when the fake happened ────────────────────────────────────
    const whenPage = inst.SettingsComponent({ api: sandbox.api });
    const minutesBox = collect(whenPage).find((n) => String(n?.props?.placeholder ?? '').includes('Minutes ago'));
    if (!minutesBox) throw new Error('no "minutes ago" box on the page');
    minutesBox.props.onChangeText('30');
    const timedPage = inst.SettingsComponent({ api: sandbox.api });
    const beforeWhen = sandbox.dispatched.length;
    // The sender picked earlier in the run is still You.
    const whenSend = collect(timedPage).find(
        (n) => String(n?.props?.label ?? '').startsWith('Send as ') && typeof n.props.onPress === 'function',
    );
    if (!whenSend) throw new Error('no send button on the page after choosing a time');
    whenSend.props.onPress();
    const stamped = sandbox.dispatched.slice(beforeWhen).find((e) => e.type === 'MESSAGE_CREATE')?.message;
    if (!stamped) throw new Error('choosing a time stopped the message from sending');
    const aged = (Date.now() - Date.parse(stamped.timestamp)) / 60000;
    if (aged < 29 || aged > 31) throw new Error('the chosen time was ignored: ' + aged.toFixed(1) + ' min');
    for (const choice of ['Now', '5 minutes ago', 'Yesterday']) {
        if (!textOf(timedPage).includes(choice)) throw new Error('no time choice: ' + choice);
    }

    // ── A client that records no import paths ────────────────────────────────
    // The installed client reports an empty import map, so a module can only be
    // found by its component name, and the button can only be Discord's own by
    // cloning one out of the row. Both are checked here.
    const namedBox = createSandbox({ strictNative: true });
    const namedEvents = [];
    namedBox.provide({ dispatch: (event) => namedEvents.push(event), subscribe: () => () => {} }, {
        provides: ['dispatch', 'subscribe'],
    });
    namedBox.provide({ getChannelId: () => CHAT }, { provides: ['getChannelId'] });
    namedBox.provide({ getChannel: (id) => ({ id, recipients: [OTHER] }) }, { provides: ['getChannel'] });
    namedBox.provide({ getCurrentUser: () => ({ id: 'me', username: 'me' }) }, { provides: ['getCurrentUser'] });
    await namedBox.api.jsonStorage.set({ button: true });

    function OwnButton(props) {
        return { type: OwnButton, props, children: props?.children };
    }

    // Discord's own chat-input button: it carries an IconComponent and an
    // onPressExpression, which is how the plugin recognises it.
    function namedRow() {
        const emoji = {
            type: OwnButton,
            props: { IconComponent: () => null, accessibilityLabel: 'Emoji', onPressExpression: 'emoji', onPress: () => {} },
        };
        return { type: 'Row', props: { children: [emoji] }, children: [emoji] };
    }

    // The module has no path, only a component name — the client shape that
    // broke every path-based lookup.
    const namedType = function (props) {
        return namedRow();
    };
    namedType.displayName = 'ChatInput';
    const namedModule = { type: namedType };
    namedBox.provide(namedModule, { provides: [] });

    const namedInst = loadBundle('dev.8uvu.fake-dm', namedBox);
    await namedInst.start(namedBox.api);
    // Read it back through the module: the patch replaces `type` on the exports.
    const namedOut = namedModule.type();
    const namedKids = namedOut?.props?.children ?? [];
    const namedButton = namedKids.find((kid) => kid?.props?.accessibilityLabel === 'FakeDM');
    if (!namedButton) throw new Error('no import map: the button was not added by component name');
    if (namedButton.type !== OwnButton) throw new Error("no import map: the button is not Discord's own");
    if (namedButton.props.accessibilityLabel !== 'FakeDM') throw new Error('no import map: wrong label');
    if (typeof namedButton.props.IconComponent !== 'function') throw new Error('no import map: no icon');
    const namedBefore = namedEvents.length;
    namedButton.props.onPress();
    const namedSent = namedEvents.slice(namedBefore).find((event) => event.type === 'MESSAGE_CREATE');
    if (!namedSent) throw new Error('no import map: pressing the button sent nothing');
    if (namedSent.message.author.id !== OTHER.id) throw new Error('no import map: wrong sender');

    // The menu the button opens, when the client ships ContextMenu.
    const menuBox = createSandbox({ strictNative: true });
    const menuEvents = [];
    menuBox.provide({ dispatch: (event) => menuEvents.push(event), subscribe: () => () => {} }, {
        provides: ['dispatch', 'subscribe'],
    });
    menuBox.eventLog = menuEvents;
    menuBox.provide({ getChannelId: () => CHAT }, { provides: ['getChannelId'] });
    menuBox.provide({ getChannel: (id) => ({ id, recipients: [OTHER] }) }, { provides: ['getChannel'] });
    menuBox.provide({ getCurrentUser: () => ({ id: 'me', username: 'me' }) }, { provides: ['getCurrentUser'] });
    await menuBox.api.jsonStorage.set({ button: true });
    function Menu(props) {
        return { type: Menu, props, children: props?.children };
    }
    menuBox.designStub.ContextMenu = function ContextMenu(props) {
        return { type: 'DContextMenu', props, children: props?.children };
    };
    const menuType = function (props) {
        return namedRow();
    };
    menuType.displayName = 'ChatInput';
    const menuModule = { type: menuType };
    menuBox.provide(menuModule, { provides: [] });
    const menuInst = loadBundle('dev.8uvu.fake-dm', menuBox);
    await menuInst.start(menuBox.api);
    const menuOut = menuModule.type();
    const menuButton = (menuOut?.props?.children ?? []).find((kid) => Array.isArray(kid?.props?.items));
    if (!menuButton) throw new Error('menu: the button was not wrapped in a menu');
    if (menuButton.type !== 'DContextMenu') throw new Error('menu: the menu is not Discord\'s ContextMenu');
    const menuItems = menuButton.props.items ?? [];
    for (const expected of ['Send the message', 'Send a call', 'Send a missed call', 'Send the batch', 'Clear fakes here']) {
        if (!menuItems.some((item) => item.label === expected)) throw new Error('menu is missing: ' + expected);
    }
    if (typeof menuItems[0]?.action !== 'function') throw new Error('menu entries do nothing');

    // Every entry opens Discord's dialog with a person picker and that action's
    // own fields, and its Send does the action with what is in them.
    const expectControls = {
        'Send the message': 3,
        'Send a call': 3,
        'Send a missed call': 2,
        'Send the batch': 3,
        'Add a reaction': 4,
        'Clear fakes here': 0,
    };
    menuBox.eventLog.length = 0;
    for (const item of menuItems) {
        item.action();
        const alert = menuBox.modalAlerts.pop();
        if (!alert) throw new Error(item.label + ': no dialog opened');
        const modal = alert.element;
        if (modal?.props?.title !== item.label) throw new Error(item.label + ': dialog is titled ' + modal?.props?.title);
        const expected = expectControls[item.label];
        if (expected === undefined) throw new Error('unexpected menu entry: ' + item.label);
        const controls = [];
        const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (typeof node.props?.onChangeText === 'function' || typeof node.props?.onChange === 'function') controls.push(node);
            for (const kid of node.props?.children ?? node.children ?? []) walk(kid);
        };
        walk(modal?.props?.content);
        if (controls.length !== expected) throw new Error(item.label + ': ' + controls.length + ' control(s), expected ' + expected);
        for (const control of controls) {
            if (typeof control.props.value !== 'string') throw new Error(item.label + ': a control starts empty');
        }
        const pickers = controls.filter((control) => typeof control.props?.onChange === 'function');
        const wantsPeople = item.label !== 'Clear fakes here';
        if (pickers.length !== (wantsPeople ? 1 : 0)) throw new Error(item.label + ': ' + pickers.length + ' person picker(s)');
        for (const picker of pickers) {
            const rows = picker.children ?? picker.props.children ?? [];
            if (!rows.length) throw new Error(item.label + ': the person picker has nobody in it');
            for (const row of rows) {
                if (!row?.props?.value) throw new Error(item.label + ': a person row has no id');
            }
            const search = controls.some((control) => control.props?.placeholder === 'Search people');
            if (!search) throw new Error(item.label + ': no search box for the people');
            if (!rows.some((row) => row.props.value === picker.props.value)) {
                throw new Error(item.label + ': nobody is picked to start with');
            }
        }
        const send = modal?.props?.actions;
        if (typeof send?.props?.onPress !== 'function') throw new Error(item.label + ': no Send button');
        send.props.onPress();
    }
    const sentFromMenu = menuBox.eventLog.filter((event) => event.type === 'MESSAGE_CREATE');
    if (!sentFromMenu.length) throw new Error('the message dialog sent nothing');
    if (sentFromMenu[0].message.content !== 'hello') throw new Error('the message dialog sent ' + sentFromMenu[0].message.content);
    if (sentFromMenu[0].message.author.id !== 'me') throw new Error('the message dialog ignored the picked person');
    delete menuBox.designStub.ContextMenu;

    // A hostile host must never make start throw.
    const hostile = createSandbox({ strictNative: true });
    hostile.host.discord.modules.settings.onSettingsModulesLoaded = () => {
        throw new Error('boom');
    };
    hostile.host.discord.utils.modules.finders.getModuleWithImportedPath = () => {
        throw new Error('boom');
    };
    const hostileInst = loadBundle('dev.8uvu.fake-dm', hostile);
    try {
        await hostileInst.start(hostile.api);
    } catch (error) {
        throw new Error('start threw on a hostile host: ' + error.message);
    }
    const hostileText = textOf(hostileInst.SettingsComponent({ api: hostile.api }));
    if (!hostileText.includes('Send as')) throw new Error('settings broke on a hostile host');

    // ── Lazy modules: the chat input only exists once a chat is opened ───────
    // Start with no chat input in the registry, then make it appear the way
    // opening a chat does. That is the case that used to leave no button ever.
    const lateBox = createSandbox({ strictNative: true });
    lateBox.provide({ dispatch: () => {}, subscribe: () => () => {} }, { provides: ['dispatch', 'subscribe'] });
    await lateBox.api.jsonStorage.set({ button: true });
    const lateInst = loadBundle('dev.8uvu.fake-dm', lateBox);
    await lateInst.start(lateBox.api);

    function LateButton(props) {
        return { type: LateButton, props, children: props?.children };
    }
    const lateInput = makeChatInput(defaultTree);
    lateBox.provide({ default: LateButton }, { path: BUTTON_PATH });
    lateBox.provide({ default: lateInput }, { path: INPUT_PATH });
    lateBox.moduleLoaded();
    const lateTree = lateInput.type();
    if (!lateTree?.props?.children || lateTree.props.children.length !== 2) {
        throw new Error('lazy chat input: the button did not install when the chat input appeared');
    }
    if (lateTree.props.children[0]?.type !== LateButton) {
        throw new Error('lazy chat input: the wrong element was added');
    }

    for (const cleanup of [
        ...sandbox.cleanups,
        ...offBox.cleanups,
        ...hostile.cleanups,
        ...lateBox.cleanups,
        ...plain.cleanups,
        ...blindBox.cleanups,
        ...chosenOff.cleanups,
        ...freshBox.cleanups,
    ])
        cleanup();
    console.log('VERIFY OK: fake message/call/system/reaction/clear, picture+reply+embed, timed batch, settings page and section, own action button in the chat bar, restart, switched off, hostile host');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    if (error?.stack) console.error(error.stack);
    process.exit(1);
});
