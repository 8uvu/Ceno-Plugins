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
| **Watchlist** | Get a toast when someone you watch comes online, types to you, or sends a message. | 1.1.0 |
| **Later** | Hold a message and be pinged about it in an hour, in three hours, or tomorrow. | 1.1.0 |
| **Bookmarks** | Keep a message on this device: the text, its author, the channel and the time. | 1.0.0 |
| **Keywords** | Get a toast when a message contains a word you follow. | 1.0.0 |
| **Last Seen** | A local record of when people came online and went away. | 1.0.0 |
| **Away** | Answers your DMs while you are out, with a reply you wrote. | 1.0.0 |
| **Waiting on You** | The DMs whose last message is theirs, oldest first. | 1.0.0 |
| **TypingWatch** | Remembers who started typing, in case the indicator vanished before you looked. | 1.2.0 |
| **Don't Control Me** | Rejoins calls, returns you to your pinned channel, and undoes server mute and deafen when you have permission. | 1.2.0 |

---

## Watchlist

Some people are worth a tap on the shoulder. Add them from a message and get a
toast when they are around.

- **Watch from the message menu.** Hold any message and pick *Watch <name>*; the
  same row becomes *Stop watching <name>* afterwards.
- **Three notifications, three switches:** coming online, starting to type to
  you, and sending a message.
- **Quiet by design.** One toast per person per kind of event — 15 seconds for
  typing, 5 for messages, 60 for presence — and presence only fires on a change
  out of offline, so a client that repeats presence cannot spam you.
- **Your own messages are ignored,** and so is everyone not on the list.
- **Stays on this device.** No account, no server, no token.

**Settings page:** the four switches and the list of watched people, with a tap
that removes one.

## Later

Hold a message and ask to be pinged about it in an hour, in three hours, or
tomorrow — useful for the message you cannot deal with right now.

- **Three delays in the message menu,** plus *Cancel the ping for this message*
  once one exists. Pressing the same delay again replaces the ping instead of
  duplicating it.
- **The ping is a toast** that quotes the message, its author and the channel.
- **Honest about the app being closed.** A ping that came due while Discord was
  closed is shown the next time the plugin starts, not as a phone notification.
- **Capped at 50 pings,** soonest first, and the page can cancel them all.

**Settings page:** the switch, the waiting pings in order, and the row that
cancels every one.

## Bookmarks

Hold a message and keep it. The text, who wrote it, the channel and the time stay
on this device — useful for the link you will want later and the thing you cannot
act on now.

- **Save and unsave from the message menu.** Hold any message and pick *Save this
  message*; the same row becomes *Remove this bookmark* afterwards.
- **Kept as it was.** An edit or a deletion afterwards does not change what you
  kept, because the text is copied when you save it.
- **Attachments are named, never downloaded.** A bookmark of a picture says so; it
  does not copy the file.
- **500 bookmarks,** newest first, each with how long ago it was saved.
- **Removing one asks first,** with the system dialog, so a tap while scrolling
  cannot lose it. *Remove every bookmark* is one row.
- **Nothing is uploaded.** No account, no server, no token.

**Settings page:** the switch, the count, the clear-all row, what is kept, and the
list — tap one to remove it.

## Keywords

A watch on words rather than on people: when a message contains one, a toast says
which word, where, and who wrote it.

- **Whole words, any case.** `cat` does not fire on `concatenate`.
- **One toast per word per channel a minute,** so a busy conversation cannot turn
  into a toast storm.
- **The toast quotes the message,** so you can tell at a glance whether it matters.
- **Your own messages never fire,** and neither does a word you did not add.
- **Up to 50 words,** separated by commas or new lines and edited on the page.
- **The list stays here.** No account, no server, no token.

**Settings page:** the switch, the word field, how many words are being watched, and
the row that clears the list.

## Last Seen

Records when people came online and when they went away, so *were they around?* has
an answer after the fact.

- **Only real changes.** Discord repeats presence constantly as activities change;
  a repeat is not coming or going and is not written.
- **Online now first, then last seen,** most recent first, with how long each has
  been online or how long ago they left.
- **It starts when the plugin starts.** Time before that is not known, and the page
  says so instead of guessing.
- **200 people,** the latest change kept per person.
- **Forget everyone** is one row.

**Settings page:** the switch, the forget-all row, how it knows, and the two lists.

## Away

While you are out, Discord answers your DMs with one short line you wrote — so
someone who needs you gets an answer instead of silence.

- **Off by default.** Turn it on when you leave, off when you are back.
- **One reply per chat per cooldown:** every hour, three, six, twelve, or once a
  day. A second message in the same chat waits its turn.
- **DMs, and group DMs if you want them.** A server channel is never answered,
  and neither is a bot or your own message.
- **Sent as you, through Discord’s own message action.** No account, no server,
  no token, and nothing else leaves the app.
- **Only while Discord is open.** A message that arrives while the app is closed
  gets no reply, and the page says so.
- **A recent-replies list,** and a line that tells you whether this build
  exposes the action it needs.

**Settings page:** what is happening now, the reply text, the group switch, the
cooldown choices, the recent replies, and the limits in plain words.

## Waiting on You

A local list of the conversations whose last message is theirs: the ones you
meant to answer and did not.

- **Oldest first,** with the message preview and how long it has been waiting.
- **Send anything and the chat leaves the list,** because you answered.
- **DMs by default,** group DMs when you turn them on.
- **Only what it saw.** The list starts empty; a chat whose last message arrived
  before the plugin started is not listed until something new happens there.
- **Tap a chat to take it off the list,** or clear the whole list.

**Settings page:** the oldest waiting chat, the list, the two switches, and what
it can and cannot know.

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

### The page kit

`plugins/_shared/lib/` is the one place a settings page is assembled, so every
plugin draws the same way instead of each one inventing its own layout:

- **`kit.tsx`** — `Page`, `Intro`, `Hero`, `Section`, `Row`, `SwitchRow`,
  `Field`, `Choices` and `Note`. Each piece looks Discord’s component up when it
  is drawn and falls back to React Native with theme tokens, so a build that
  lacks one loses a row’s decoration, never the page.
- **`settings.ts`** — `useSettings(storage, defaults)`: the current value plus a
  setter, and a subscription so a page notices a change that came from a
  listener rather than from the page.
- **`toast.ts`** — `say(key, text, tone)`, with the older toast shape as a
  fallback.
- **`confirm.ts`** — `ask({title, body, confirm, danger, onConfirm})` on the
  system dialog every build has.
- **`format.ts`** — names, channels, `clip`, `span`, `ago`, `plural`, `listOf`,
  and `phrase` for a readable list of people.

Every settings page in this repository is built on it — the older plugins and
the new ones alike — so they all open the same way.

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
├── dont-control-me/
├── watchlist/
├── later/
├── bookmarks/
├── keywords/
├── last-seen/
├── away/
├── waiting-on-you/
└── _shared/                     # theme tokens, the page kit and the menu patch
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
