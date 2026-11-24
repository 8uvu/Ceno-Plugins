// Runs every plugin's verify.cjs against its built bundle.
//
// Each verifier boots the bundle the way the client does (see
// valenced-harness.cjs), so a PASS here means the plugin loads, its settings
// page renders, and the behaviour it claims actually happens. Build first:
//   bun run build && bun run verify
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const plugins = join(root, 'plugins');

let ran = 0;
const failed = [];

for (const name of readdirSync(plugins).sort()) {
    // A retired plugin may still sit in the working copy; it is not published,
    // so it is not part of the run.
    if (existsSync(join(plugins, name, 'RETIRED'))) {
        console.log('SKIP (retired): ' + name);
        continue;
    }
    const file = join(plugins, name, 'verify.cjs');
    if (!existsSync(file)) continue;
    ran++;
    const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) failed.push(name);
}

if (!ran) {
    console.error('VERIFY FAILED: no plugin has a verify.cjs');
    process.exit(1);
}

if (failed.length) {
    console.error('VERIFY FAILED: ' + failed.join(', '));
    process.exit(1);
}

console.log('VERIFY OK: ' + ran + ' plugin verifier(s) passed');
