# Ceno Plugins

Valenced plugins by cenotaph, built from the
[official plugin template](https://github.com/Valenced/valenced-plugin-template).

**Repository URL**

```
https://8uvu.github.io/Ceno-Plugins/index.json
```

Add it in Settings → Valenced → Plugins → Advanced → Repository URL, then install
from the list.
Updates come through the same repository.

## Plugins

| Plugin | What it does | Version |
| --- | --- | --- |
| **FakeDM** | Fake messages and calls in the chat you have open. Drawn locally, never sent. | 6.0.9 |
| **TypingWatch** | Remembers who started typing, in case the indicator disappeared before you looked. | 1.0.12 |
| **Clean URLs** | Strips tracking parameters from links. | 1.1.11 |
| **Don't Control Me** | Rejoins calls, returns you to your pinned channel, and undoes server mute and deafen when you have permission. | 1.1.8 |
| **Streaks** | Counts how many days in a row you have talked to someone and shows the count next to their name. Stays on this device. | 1.1.0 |
| **Message Deleter** | Deletes your own messages in a DM: hold one message, or open the chat's list and pick several. Asks first, one request at a time. | 2.1.1 |

## Layout

Each folder under `plugins/` is one plugin, named after the plugin; the `id` the
catalog keys on is in its manifest.
```
plugins/
├── fake-dm/                     # JS-only: no src/main, no dist.android
│   ├── manifest.json            # id (dev.8uvu.fake-dm), metadata, dist.script
│   ├── tsconfig.json            # the plugin's own type-check project
│   └── js/index.tsx             # -> index.js
├── typing-watch/
├── clean-urls/
├── dont-control-me/
├── streaks/
├── message-deleter/
└── _shared/                     # theme tokens and shared runtime types
themes/                          # theme plugins, built and packaged like plugins/
types/                           # declarations for the @valenced/* imports
tsconfig.base.json               # compiler options every plugin inherits
biome.json                       # lint and format config
repo.config.json                 # repository name and channels
```

Every plugin here is strict TypeScript + React with no `any` in plugin code, and
none of them ship native (`src/main/kotlin`, `plugin.jar`), `assets/` or theme
packs — `themes/` is empty.

## Build

```
bun install
bun run build            # valenced-plugin build -> plugins/<name>/build/js/index.js
bun run generate-index   # writes index.json from the published pool
bun run lint             # biome
bun run lint:types       # tsc -b plugins/*/tsconfig.json
```
The published catalog lives on the `gh-pages` branch (`index.json`, `pool/*.zip`
and one folder per plugin) and is what the URL above serves. It was built from
these sources with the repository's own bundler and is committed there so the
catalog stays installable while the CLI pipeline is still being verified; the
template's GitHub Actions workflows are kept, with `Release plugins` set to manual
(`workflow_dispatch`) until that pipeline builds these sources.
