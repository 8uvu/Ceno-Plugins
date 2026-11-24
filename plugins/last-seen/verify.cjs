// Verifies Last Seen: coming online and going away are recorded, a repeated
// presence update is not written again, a payload without a status is ignored,
// your own presence is ignored, a missing name falls back to the user store, the
// page splits online from last seen, forgetting clears it, and switching the
// plugin off stops recording.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

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

async function main() {
    const sandbox = createSandbox({
        stores: {
            UserStore: {
                getCurrentUser: () => ({ id: 'me' }),
                getUser: (id) => ({ id, username: id === 'bob' ? 'Bob' : 'Ada' }),
            },
        },
    });

    const inst = loadBundle('dev.8uvu.last-seen', sandbox);
    await inst.start(sandbox.api);
    await tick();

    // ── Coming online ────────────────────────────────────────────────────────
    const now = Date.now();
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'ada', username: 'Ada' }, status: 'online' });
    await tick();
    let people = sandbox.stored.people ?? {};
    if (!people.ada) throw new Error('the presence change was not recorded: ' + JSON.stringify(people));
    if (people.ada.online !== true) throw new Error('Ada is not recorded as online');
    if (people.ada.name !== 'Ada') throw new Error('wrong name: ' + people.ada.name);
    if (Math.abs(people.ada.lastOnline - now) > 10000) throw new Error('wrong online time: ' + people.ada.lastOnline);
    const firstAt = people.ada.at;

    // A repeated update with an activity attached is not a change, so it is not
    // written again.
    sandbox.emit('PRESENCE_UPDATE', {
        user: { id: 'ada', username: 'Ada', activities: [{ name: 'a game' }] },
        status: 'online',
    });
    await tick();
    if ((sandbox.stored.people.ada ?? {}).at !== firstAt) {
        throw new Error('a repeated presence update was written again');
    }

    // ── A payload without a status says nothing ──────────────────────────────
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'ada', username: 'Ada' } });
    await tick();
    if ((sandbox.stored.people.ada ?? {}).online !== true) {
        throw new Error('a payload without a status changed the record');
    }

    // ── Going away ───────────────────────────────────────────────────────────
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'ada', username: 'Ada' }, status: 'offline' });
    await tick();
    people = sandbox.stored.people ?? {};
    if (people.ada.online !== false) throw new Error('Ada is not recorded as away');
    if (!people.ada.lastOffline) throw new Error('the time she went away was not kept');
    if (!people.ada.lastOnline) throw new Error('the time she came online was lost');

    // ── Your own presence is not interesting ─────────────────────────────────
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'me', username: 'Me' }, status: 'online' });
    await tick();
    if ((sandbox.stored.people ?? {}).me) throw new Error('your own presence was recorded');

    // ── A missing name falls back to the user store ──────────────────────────
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'bob' }, status: 'idle' });
    await tick();
    people = sandbox.stored.people ?? {};
    if (people.bob?.name !== 'Bob') throw new Error('the name was not resolved from the store: ' + people.bob?.name);
    if (people.bob.online !== true) throw new Error('idle is not treated as around');

    // ── The page ─────────────────────────────────────────────────────────────
    let page = inst.SettingsComponent({ api: sandbox.api });
    let text = textOf(page);
    for (const expected of ['Last Seen', 'Online now (1)', 'Bob', 'Last seen (1)', 'Ada', 'last seen']) {
        if (!text.includes(expected)) throw new Error('settings page is missing: ' + expected);
    }

    // ── Forgetting everyone ──────────────────────────────────────────────────
    const forget = rowsOf(page).find((row) => row.label.startsWith('Forget everyone'));
    if (!forget?.onPress) throw new Error('the page has no forget-everyone row');
    forget.onPress();
    await tick();
    if (Object.keys(sandbox.stored.people ?? {}).length !== 0) throw new Error('forget everyone left something behind');
    text = textOf(inst.SettingsComponent({ api: sandbox.api }));
    if (!text.includes('Nobody online now') || !text.includes('Nothing recorded yet')) {
        throw new Error('the page still lists people: ' + text);
    }

    // ── Switched off ─────────────────────────────────────────────────────────
    await sandbox.api.jsonStorage.set({ enabled: false });
    sandbox.emit('PRESENCE_UPDATE', { user: { id: 'cara', username: 'Cara' }, status: 'online' });
    await tick();
    if ((sandbox.stored.people ?? {}).cara) throw new Error('a change was recorded while switched off');
    await sandbox.api.jsonStorage.set({ enabled: true });

    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();

    console.log('VERIFY OK: online/away recorded once per change, status-less payloads ignored, own presence skipped, name fallback, page splits the lists, forget-all, switched off');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
