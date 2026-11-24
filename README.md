# Ceno Plugins

Small, careful plugins for [Valenced](https://github.com/Valenced/valenced), the
mobile Discord client mod — by cenotaph.

**Add this repository**

```
https://8uvu.github.io/Ceno-Plugins/index.json
```

Settings → Valenced → Plugins → Advanced → Repository URL, paste that, then
install from the list. Updates arrive through the same URL.

Every plugin here is local-only: no account, no server, no token. They use
Discord's own actions and stores, follow the theme you are using, and do nothing
in the background.

## What's inside

| Plugin | What it does | Version |
| --- | --- | --- |
| **Message Deleter** | Hold a message and delete what you sent in that chat: one message, or all of them, a second apart. | 3.0.0 |
| **TypingWatch** | Remembers who started typing, in case the indicator vanished before you looked. | 1.1.0 |
| **Clean URLs** | Strips tracking parameters from links. | 1.1.11 |
| **Don't Control Me** | Rejoins calls, returns you to your pinned channel, and undoes server mute and deafen when you have permission. | 1.1.8 |
| **Streaks** | Counts how many days in a row you have talked to someone and shows the count next to their name. | 1.1.0 |

---

## Message Deleter

Hold a message you sent, or any message in a DM, and the long-press menu offers
to delete what you wrote. The chat list offers the same run when you hold the
conversation.

- **One message.** Hold one of your own messages → *Delete this message*.
- **Every message of yours.** In a DM or group DM → *Delete all my messages*.
  The run reads the chat a page at a time and deletes as it walks, so it works on
  a conversation of any length.
- **Newest first, one request at a time,** a second apart — a walk, not a burst.
- **Discord's limits are obeyed.** A `429` is waited out for exactly the delay
  Discord names, then the delete is retried once. A second refusal stops the run
  and says so instead of retrying into the limit.
- **Only your own messages.** In a server, a single message can be deleted; the
  bulk run is only offered in DMs and group DMs.
- **It asks first,** with the system dialog, after the sheet has closed — so the
  confirmation is never drawn underneath it.
- **Stop while it runs:** *Stop deleting (N done)* in the same menu, or the row in
  the settings page. The message already being deleted finishes.

**Settings page:** what each row does, the last result, and a *Diagnostics*
group — message menu, chat menu, delete action, chat history — that names the
piece a build did or did not provide, so a missing row can be reported exactly.

## TypingWatch

Discord's typing indicator lasts a few seconds. If you looked away, you missed
it. TypingWatch keeps the last 20 typing starts, one row per person and channel,
newest first, and shows them with names instead of ids.

- **Names, not snowflakes.** The user and channel stores are asked when the page
  is drawn; an id is the fallback if a store is not loaded.
- **A listener, not a gate.** The event is passed back to Discord untouched, so
  everyone still sees the normal indicator.
- **One row per person and channel.** Typing again moves that row up instead of
  filling the list with duplicates.
- **Clear the list** from the settings page, or switch recording off entirely.

## Clean URLs

Tracking parameters are removed from links as messages arrive and as they are
edited, before Discord renders them.

- **The usual suspects:** `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`,
  `twclid`, `igshid`, `si`, `mkt_tok`, `_hsenc`, and the other `fb_`, `ga_`,
  `mc_`, `matomo_`, `pk_` and `mtm_` families.
- **Add your own** as a comma-separated list in the settings page.
- **Nothing else changes:** the path, the fragment, the remaining parameters and
  the surrounding text are left exactly as written, and a link that was already
  clean is not touched.
- **Works on what you see.** It rewrites the message the client is about to
  render; nothing is sent anywhere and the other person's copy is unchanged.

## Don't Control Me

Being moved, muted, deafened or dropped out of a call by a server admin is
sometimes the point — and sometimes not. This puts you back, and lets you choose
which of those it does.

- **Rejoin when you get disconnected.** Discord drops you out; the plugin puts
  you back after the delay you picked: straight away, 2, 5 or 10 seconds.
- **Return to your pinned channel** when someone moves you out of it.
- **Undo server mute and deafen** while you are still in the call.
- **Pin a channel** from the settings page — the pin wins over the last call you
  were in. With no pin it goes back to the last call it saw you in.
- **Only your own voice state** is read; another person moving is ignored.
- **Every action is guarded** against repeats, so a fast reconnect cannot fire
  the same join twice.

**Settings page:** the four switches, the rejoin delay, the pinned channel, and a
line telling you what it would rejoin right now.

## Streaks

How many days in a row you and someone have talked, counted on this device.

- **A day counts when a message goes either way,** so texting someone starts the
  streak. *Both sides count* is available if you want a day to need a reply from
  each of you.
- **The streak is drawn next to the name** in the chat header, and survives a day
  with nothing said yet: an empty today starts counting from yesterday.
- **Local dates,** so a streak survives time zones and daylight saving.
- **DMs and group DMs only.** Server channels are not counted.
- **400 days of history per conversation** is kept, and the longest streak is
  remembered even after a gap.
- **Reset everything** from the settings page.

**Settings page:** the switches, your best running streak, and every
conversation ranked by streak with today's count.

---

## How they're built

- **Strict TypeScript, no `any`, no native code.** Each plugin is one JS bundle;
  there is no Kotlin, no `plugin.jar`, no assets.
- **Theme tokens only.** Colours come from Discord's semantic tokens for the
  appearance that is active right now, so the pages read correctly in dark,
  light, midnight and any custom theme.
- **Every lookup is guarded.** A build that moved a module loses that one
  feature, not the screen: each patch returns Discord's own element on any error.
- **Every plugin has a verifier** that boots the built bundle the way the client
  does and checks the behaviour it claims — the rows appear where they should,
  the switches stop the work, the unpatch puts the client back.
- **No private endpoints and no copied tokens.** The plugins use the client's own
  actions, stores and HTTP module, so the session never leaves Discord.

## Build and test

```
bun install
bun run build        # valenced-plugin build -> plugins/<name>/build/js/index.js
bun run verify       # boots every built bundle and checks it
bun run lint         # biome
bun run lint:types   # tsc -b plugins/*/tsconfig.json
bun run generate-index
```

`bun run verify` runs each plugin's `verify.cjs` against the harness in
`scripts/valenced-harness.cjs`: a small stand-in for the client that provides
`valenced.*`, the design components, the stores and the action creators. A PASS
means the bundle loads the way the client loads it, the settings page renders,
and the plugin does what its page says.

## Layout

Each folder under `plugins/` is one plugin, named after the plugin; the `id` the
catalog keys on is in its manifest.

```
plugins/
├── typing-watch/
│   ├── manifest.json            # id (dev.8uvu.typing-watch), metadata, dist.script
│   ├── tsconfig.json            # the plugin's own type-check project
│   ├── verify.cjs               # boots the built bundle and checks it
│   └── js/index.tsx             # -> index.js
├── clean-urls/
├── dont-control-me/
├── streaks/
├── message-deleter/
└── _shared/                     # theme tokens and shared runtime types
scripts/                         # the verifier harness and its runner
themes/                          # theme plugins, built and packaged like plugins/
types/                           # declarations for the @valenced/* imports
tsconfig.base.json               # compiler options every plugin inherits
biome.json                       # lint and format config
repo.config.json                 # repository name and channels
```

## Publishing

The published catalog lives on the `gh-pages` branch (`index.json`, `pool/*.zip`
and one folder per plugin), which is what the URL above serves. It is built from
these sources by the repository's own bundler: the `Release plugins` workflow is
manual (`workflow_dispatch`), and it plans a release for any plugin whose
manifest version is not in the pool yet. Version numbers never go down.
