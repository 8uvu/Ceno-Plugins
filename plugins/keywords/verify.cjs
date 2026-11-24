// Verifies Keywords: a matching message produces one toast naming the word, the
// channel and the author, the per-channel throttle holds, matching is whole-word
// and case-insensitive, your own messages never fire, the page counts the list,
// the list is capped, and switching the plugin off stops the toasts.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

const CHANNEL = 'c1';

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: { getCurrentUser: () => ({ id: 'me' }) },
            ChannelStore: {
                getChannel: (id) => (id === CHANNEL ? { id, name: 'general', guild_id: 'g1' } : { id, name: 'other', guild_id: 'g1' }),
            },
        },
    });

    const inst = loadBundle('dev.8uvu.keywords', sandbox);
    await inst.start(sandbox.api);
    await tick();
    await sandbox.api.jsonStorage.set({ words: 'invoice, deadline' });

    let counter = 0;
    const send = (content, authorId = 'ada', channelId = CHANNEL) =>
        sandbox.emit('MESSAGE_CREATE', {
            message: {
                id: 'm' + ++counter,
                channel_id: channelId,
                content,
                author: { id: authorId, username: authorId === 'ada' ? 'Ada' : authorId },
            },
        });

    // ── A match, case-insensitively ──────────────────────────────────────────
    send('The Invoice is late');
    await tick();
    if (sandbox.toasts.length !== 1) throw new Error('expected one toast, got: ' + JSON.stringify(sandbox.toasts));
    const toast = sandbox.toasts[0];
    for (const expected of ['Keyword “invoice”', '#general', 'Ada', 'The Invoice is late']) {
        if (!toast.includes(expected)) throw new Error('the toast is missing ' + expected + ': ' + toast);
    }

    // ── Throttled per word and channel ───────────────────────────────────────
    send('the invoice again');
    await tick();
    if (sandbox.toasts.length !== 1) throw new Error('the throttle did not hold: ' + JSON.stringify(sandbox.toasts));

    // A different word is its own throttle, in the same channel.
    send('deadline tomorrow');
    await tick();
    if (sandbox.toasts.length !== 2) throw new Error('a second word did not fire');
    if (!sandbox.toasts[1].includes('Keyword “deadline”')) {
        throw new Error('the second toast names the wrong word: ' + sandbox.toasts[1]);
    }

    // ── Whole words only ─────────────────────────────────────────────────────
    send('concatenate the strings');
    await tick();
    if (sandbox.toasts.length !== 2) throw new Error('a word inside a longer word fired: ' + JSON.stringify(sandbox.toasts));

    // ── Your own messages never fire ─────────────────────────────────────────
    send('my own invoice', 'me', 'c2');
    await tick();
    if (sandbox.toasts.length !== 2) throw new Error('your own message fired');

    // ── Unwatched words are quiet ────────────────────────────────────────────
    send('nothing to see here', 'ada', 'c2');
    await tick();
    if (sandbox.toasts.length !== 2) throw new Error('an unrelated message fired');

    // ── The page ─────────────────────────────────────────────────────────────
    let text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    for (const expected of ['Keywords', 'Watch my words', 'Watching 2 words', 'Quiet by design']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── The list is capped ───────────────────────────────────────────────────
    const many = Array.from({ length: 60 }, (_, index) => 'word' + index).join(', ');
    await sandbox.api.jsonStorage.set({ words: many });
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Watching 50 words')) {
        throw new Error('the list was not capped at 50: ' + text);
    }

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false, words: 'invoice' });
    send('invoice in another channel', 'ada', 'c2');
    await tick();
    if (sandbox.toasts.length !== 2) throw new Error('a toast fired while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();

    console.log('VERIFY OK: one toast per word and channel, throttle, whole words, own messages ignored, page count, list capped, switched off');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
