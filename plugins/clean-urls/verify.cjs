// Verifies Clean URLs: tracking params are stripped from message content.
const { createSandbox, loadBundle, textOf, tick } = require('../../scripts/valenced-harness.cjs');

async function main() {
    const sandbox = createSandbox();
    const inst = loadBundle('dev.8uvu.clean-urls', sandbox);
    await inst.start(sandbox.api);

    const payload = (content) => ({ message: { content } });
    const scrubbed = sandbox.fluxHandlers.get('MESSAGE_CREATE')(payload('https://example.com/?utm_source=x&keep=1'));
    if (scrubbed.message.content !== 'https://example.com/?keep=1') {
        throw new Error('tracking params not stripped: ' + scrubbed.message.content);
    }
    const clean = sandbox.fluxHandlers.get('MESSAGE_UPDATE')(payload('https://example.com/?keep=1'));
    if (clean.message.content !== 'https://example.com/?keep=1') throw new Error('clean link was changed');
    if (!sandbox.fluxHandlers.has('MESSAGE_CREATE') || !sandbox.fluxHandlers.has('MESSAGE_UPDATE')) {
        throw new Error('did not subscribe to both message flux events');
    }

    const ui = inst.SettingsComponent({ api: sandbox.api });
    const text = textOf(ui);
    for (const expected of ['Clean URLs', 'Strip tracking parameters', 'Extra parameters']) {
        if (!text.includes(expected)) throw new Error('settings UI missing: ' + expected);
    }
    await inst.stop?.();
    for (const cleanup of sandbox.cleanups) cleanup();
    console.log('VERIFY OK: tracking params stripped, settings UI renders');
}

main().catch((error) => {
    console.error('VERIFY FAILED:', error?.message ?? error);
    process.exit(1);
});
