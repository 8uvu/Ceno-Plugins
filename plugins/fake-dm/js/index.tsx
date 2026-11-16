// FakeDM draws fake messages, calls, system messages and reactions into the
// chat you have open.
//
// How it works: it builds a normal Discord message object and hands it to
// Discord's own event dispatcher (Flux) as if it had just arrived. Discord
// renders it from its local cache, nothing is uploaded, and nobody else sees
// it. Every fake id is remembered so "Clear fakes" can delete them again.

import {
	AlertActionCreators,
	ToastActionCreators,
} from '@valenced/discord/actions'
import { Dispatcher } from '@valenced/discord/common/flux'
import * as ImportTracker from '@valenced/discord/common/import-tracker'
import { Design } from '@valenced/discord/design'
import { getStore, Stores } from '@valenced/discord/flux'
import * as SettingsModules from '@valenced/discord/modules/settings'
import * as PathFinders from '@valenced/discord/utils/modules/finders'
import { getModules, lookupModule } from '@valenced/modules/finders'
import {
	createFilterGenerator,
	withName,
	withProps,
} from '@valenced/modules/finders/filters'
import * as Metro from '@valenced/modules/metro/subscriptions'
import { after } from '@valenced/patcher'
import { cloneElement, createElement, isValidElement, useState } from 'react'
import {
	Image,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from 'react-native'
import { token } from '../../_shared/theme'
import { asRecord, asString, errorMessage, isRecord } from '../../_shared/types'
import type {
	DiscordChannel,
	DiscordEmbed,
	DiscordMessage,
	DiscordMessageAuthor,
	DiscordUser,
	DispatcherLike,
	JsonStorage,
	Logger,
	ModuleWithType,
	StoreLike,
} from '../../_shared/types'

type Fake = { channelId: string; id: string }
// The element type this build's React shim produces, and the shape of a
// Discord chat-bar button component (it is called, not rendered by JSX).
type Element = ReturnType<typeof createElement>
type ButtonComponent = (props: Record<string, unknown>) => Element | null
type Chat = {
	id: string
	label: string
	others: DiscordUser[]
	members: DiscordUser[]
}

// What a module finder exposes on the builds this plugin supports. Everything
// is optional: a client that dropped one of them must degrade, not throw.
interface ModuleFinders {
	getModuleWithImportedPath?(
		path: string,
		callback: (mod: ModuleWithType) => void,
	): () => void
	lookupModuleWithImportedPath?(path: string): ModuleWithType[]
}
type BatchLine = { name: string; content: string; time?: number }

const DEFAULTS = {
	text: 'hello',
	// Who the next fake is from. Empty means "the other person in this chat".
	senderId: '',
	batch: '',
	asThem: true,
	// A picture on the fake message: any URL Discord can load.
	imageUrl: '',
	// Reply to a message that is already in the chat.
	replyId: '',
	// A link embed under the message.
	embedTitle: '',
	embedDesc: '',
	embedImage: '',
	// Call settings: who rang whom, and how long it lasted.
	callSeconds: '90',
	callMissed: false,
	callerId: '',
	receiverId: '',
	// System message settings.
	systemType: 7,
	systemText: '',
	// Reaction settings.
	reactId: '',
	reactEmoji: '👍',
	// When the fake happened, counted back from now in minutes (0 = now).
	minutesAgo: '0',
	// Only needed when Discord cannot report the open chat by itself.
	chatId: '',
	// The chat bar button. Installs that have never touched the switch get it
	// switched on once (see barDefault below), so the plugin shows up in the
	// composer without anyone hunting for a setting; after that the user wins.
	button: false,
	// Marks that the one-time switch-on has happened.
	barDefault: 0,
	// Also off until asked for: adding a row to Discord's own settings list is
	// what made opening normal Settings crash on 352.6, so the plugin page in
	// the Valenced plugin list is the entry that is always used.
	section: false,
	fakes: [] as Fake[],
}

const BUTTON_PATH =
	'modules/chat_input/native/action_buttons/ChatInputActionButton.tsx'
const INPUT_PATH = 'modules/chat_input/native/ChatInput.tsx'
// Bump with the manifest: the diagnostics page shows it, and there is no
// manifest lookup available from inside the plugin.
const VERSION = '6.0.0'

// The chat-bar icon, inlined so the button looks like the other chat-bar
// plugins instead of an emoji.
const ICON =
	'data:image/png;base64,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'

// The system events Discord knows how to draw inside a DM.
const SYSTEM_TYPES: Array<{ value: number; label: string }> = [
	{ value: 1, label: 'Added someone' },
	{ value: 2, label: 'Removed someone' },
	{ value: 4, label: 'Changed the chat name' },
	{ value: 5, label: 'Changed the chat icon' },
	{ value: 6, label: 'Pinned a message' },
	{ value: 7, label: 'New member joined' },
	{ value: 8, label: 'Server boosted' },
]

const CATEGORIES = [
	{ key: 'message', label: 'Message' },
	{ key: 'call', label: 'Call' },
	{ key: 'batch', label: 'Batch' },
	{ key: 'system', label: 'System' },
	{ key: 'reaction', label: 'Reaction' },
	{ key: 'diag', label: 'Diagnostics' },
] as const

type Category = (typeof CATEGORIES)[number]['key']

const state: {
	cfg: typeof DEFAULTS
	storage: JsonStorage<typeof DEFAULTS> | null
	actionButton: ButtonComponent | null
	button: Element | null
	// Whether the built button is Discord's component or the plain fallback.
	buttonKind: '' | 'discord' | 'plain'
	patched: boolean
	// Which tab of the panel is open. Kept outside React so re-opening the
	// page lands on the same one.
	cat: Category
	// The last chat the user opened. Tapping a DM in the list selects it, and
	// not every build reports that selection, so it is remembered here too.
	lastChannelId: string
	// Guards against registering the same module callback twice.
	watchingInput: boolean
	// The component-name lookup is registered once as well.
	watchingByNameInput: boolean
	// What the lookups found, shown on the diagnostics page.
	// The module finder namespace, whichever way this build exposes it.
	finders: ModuleFinders | null
	// What the plugin API itself reported, for the diagnostics page.
	apiKeys: string
	discordKeys: string
	diag: {
		chat: string
		button: string
		input: string
		inputName: string
		channel: boolean
		recipients: number
		buttonPath: string
		inputPath: string
	}
} = {
	cfg: { ...DEFAULTS },
	storage: null,
	actionButton: null,
	button: null,
	buttonKind: '',
	patched: false,
	cat: 'message',
	lastChannelId: '',
	watchingInput: false,
	watchingByNameInput: false,
	finders: null,
	apiKeys: '',
	discordKeys: '',
	diag: {
		chat: '',
		button: '',
		input: '',
		inputName: '',
		channel: false,
		recipients: 0,
		buttonPath: '',
		inputPath: '',
	},
}

// Discord's design components, as much of them as this plugin touches. Every
// entry is optional: a build that lacks one falls back to a plain view.
type ComponentLike = (props: Record<string, unknown>) => Element | null

interface DesignRuntime {
	AlertModal?: ComponentLike
	AlertActionButton?: ComponentLike
	TableRadioGroup?: ComponentLike
	TableRadioRow?: ComponentLike
	TableRowGroup?: ComponentLike
	TableRow?: ComponentLike
	TableSwitchRow?: ComponentLike
	Stack?: ComponentLike
	Text?: ComponentLike
	ContextMenu?: ComponentLike
}

function designComponents(): DesignRuntime {
	return (Design as unknown as DesignRuntime | undefined) ?? {}
}

let seq = 0

type FoundModule = Record<string, unknown>

function find(...props: string[]): FoundModule | null {
	try {
		const found = (
			lookupModule(
				withProps(...(props as [string, ...string[]])) as never,
			) as unknown[]
		)[0]
		return isRecord(found) ? found : null
	} catch {
		return null
	}
}

function flux(): DispatcherLike | null {
	const candidates: unknown[] = []
	try {
		candidates.push(Dispatcher)
	} catch {}
	candidates.push(find('dispatch', 'subscribe'))
	for (const candidate of candidates) {
		if (
			isRecord(candidate) &&
			typeof candidate.dispatch === 'function' &&
			typeof candidate.subscribe === 'function'
		) {
			return candidate as unknown as DispatcherLike
		}
	}
	return null
}

// Discord's own stores, reached the documented way: the lazy Stores proxy
// first, then the callback form, then a scan by method name as a last resort.
function storeOf(name: string): StoreLike | null {
	try {
		const store = (Stores as Record<string, unknown> | undefined)?.[name]
		if (isRecord(store)) return store as StoreLike
	} catch {}
	try {
		let found: StoreLike | null = null
		const lookup = getStore as unknown as
			| ((key: string, cb: (store: StoreLike) => void) => void)
			| undefined
		lookup?.(name, store => {
			found = store
		})
		if (found) return found
	} catch {}
	return null
}

function me(): DiscordUser | null {
	try {
		const user = storeOf('UserStore')?.getCurrentUser?.()
		if (user) return user
	} catch {}
	try {
		const getter = find('getCurrentUser')?.getCurrentUser
		if (typeof getter === 'function')
			return (getter as () => DiscordUser | null).call(null) ?? null
	} catch {}
	return null
}

// Calls a named method on a module the finders returned, and gives null when
// the method is missing or throws. Keeps every lookup a one-liner without
// spreading `any` through the plugin.
function call<T>(
	mod: FoundModule | null,
	name: string,
	...args: unknown[]
): T | null {
	const fn = mod?.[name]
	if (typeof fn !== 'function') return null
	try {
		const result = (fn as (...values: unknown[]) => T).apply(mod, args)
		return result ?? null
	} catch {
		return null
	}
}

// Discord exposes the open chat through more than one store method depending
// on the build, so every name it uses is tried before giving up.
function currentChannelId(): string {
	const probes: Array<() => unknown> = [
		() => storeOf('SelectedChannelStore')?.getChannelId?.(),
		() => storeOf('SelectedChannelStore')?.getSelectedChannelId?.(),
		() => call<string>(find('getChannelId'), 'getChannelId'),
		() => call<string>(find('getSelectedChannelId'), 'getSelectedChannelId'),
		() =>
			call<string>(
				find('getLastSelectedChannelId'),
				'getLastSelectedChannelId',
			),
		() =>
			call<string>(
				find('getChannelId', 'getSelectedChannelId'),
				'getChannelId',
			),
	]
	for (const probe of probes) {
		try {
			const value = probe()
			if (value) return String(value)
		} catch {}
	}
	return ''
}

function channelById(id: string): DiscordChannel | null {
	const probes: Array<() => DiscordChannel | null> = [
		() => storeOf('ChannelStore')?.getChannel?.(id) ?? null,
		() => call<DiscordChannel>(find('getChannel'), 'getChannel', id),
		() =>
			call<DiscordChannel>(find('getChannel', 'hasChannel'), 'getChannel', id),
		() =>
			call<DiscordChannel>(
				find('getChannel', 'getDMFromUserId'),
				'getChannel',
				id,
			),
		() =>
			call<DiscordChannel>(find('getChannel', 'getChannels'), 'getChannel', id),
		() =>
			call<DiscordChannel>(find('hasChannel', 'getChannel'), 'getChannel', id),
	]
	for (const probe of probes) {
		try {
			const value = probe()
			if (value) return value
		} catch {}
	}
	return null
}

// A user object for an id, whatever store has it.
function userById(id: string): DiscordUser | null {
	try {
		const user = storeOf('UserStore')?.getUser?.(id)
		if (user) return user
	} catch {}
	return call<DiscordUser>(find('getUser'), 'getUser', id)
}

// Channels hand back recipients either as user objects or as bare ids
// depending on the build; this makes both usable.
function normalisePeople(list: Array<DiscordUser | string>): DiscordUser[] {
	const out: DiscordUser[] = []
	for (const entry of list ?? []) {
		if (!entry) continue
		if (typeof entry === 'string') {
			out.push(userById(entry) ?? { id: entry, username: entry })
			continue
		}
		const id = entry.id || (entry as DiscordUser & { userId?: string }).userId
		if (!id) continue
		out.push(entry.username ? entry : (userById(id) ?? entry))
	}
	return out
}

// Everyone who can appear in a server channel: the member list, topped up with
// the user objects Discord keeps for them.
type MemberMap = Record<string, { user?: DiscordUser; userId?: string }>

function guildMembers(channel: DiscordChannel | null): DiscordUser[] {
	const guildId = channel?.guild_id ?? channel?.guildId
	if (!guildId) return []
	try {
		const map =
			storeOf('GuildMemberStore')?.getMembers?.(guildId) ??
			call<MemberMap>(find('getMembers', 'getMember'), 'getMembers', guildId) ??
			call<MemberMap>(find('getMembers'), 'getMembers', guildId) ??
			{}
		return Object.values(map)
			.map(
				member =>
					member?.user ?? userById(String(member?.userId ?? '')) ?? null,
			)
			.filter((user): user is DiscordUser => Boolean(user?.id))
			.slice(0, 100)
	} catch {
		return []
	}
}

// The chat the panel works on. It follows what the user opens: the selected
// chat first, then the last chat they tapped, and only then an id typed in by
// hand. That way nothing has to be picked twice.
function openChat(): Chat | null {
	try {
		const selected = currentChannelId()
		if (selected) state.lastChannelId = selected
		const manual = String(state.cfg?.chatId ?? '').trim()
		const id = selected || state.lastChannelId || manual
		state.diag.chat = selected
			? 'selected'
			: state.lastChannelId
				? 'last tapped'
				: manual
					? 'typed'
					: ''
		if (!id) return null
		const channel = channelById(id)
		const raw = Array.isArray(channel?.recipients)
			? channel.recipients
			: Array.isArray(channel?.rawRecipients)
				? channel.rawRecipients
				: []
		const others = normalisePeople(raw)
		const members = guildMembers(channel)
		state.diag.channel = !!channel
		state.diag.recipients = others.length
		const label =
			(typeof channel?.name === 'string' && channel.name) ||
			others
				.map(u => u.globalName || u.username || u.id)
				.filter(Boolean)
				.join(', ') ||
			'chat ' + id
		return { id, label, others, members }
	} catch {
		return null
	}
}

// Finds a person in the open chat by id, username or display name.
function resolvePerson(chat: Chat, name: string): DiscordUser | null {
	const wanted = String(name ?? '')
		.trim()
		.toLowerCase()
	if (!wanted) return null
	const mine = me()
	if (
		wanted === 'me' ||
		wanted === 'you' ||
		(mine && wanted === String(mine.id).toLowerCase())
	)
		return mine
	for (const user of [...chat.others, ...(chat.members ?? [])]) {
		if (!user) continue
		const names = [user.id, user.username, user.globalName]
			.filter(Boolean)
			.map(v => String(v).toLowerCase())
		if (names.includes(wanted)) return user
	}
	return null
}

function sender(chat: Chat): DiscordUser | null {
	const mine = me()
	if (state.cfg.senderId) {
		const picked = resolvePerson(chat, state.cfg.senderId)
		if (picked) return picked
	}
	return state.cfg.asThem ? (chat.others[0] ?? mine) : mine
}

function snowflake(): string {
	const ms = BigInt(Math.max(0, Date.now() - 1420070400000))
	return ((ms << 22n) | BigInt(seq++ % 4096)).toString()
}

function author(user: DiscordUser): DiscordMessageAuthor {
	return {
		id: String(user.id ?? ''),
		username: user.username ?? 'unknown',
		discriminator: user.discriminator ?? '0',
		avatar: user.avatar ?? null,
		global_name: user.globalName ?? user.username ?? 'unknown',
		bot: Boolean(user.bot),
	}
}

function saveFakes(list: Fake[]) {
	state.cfg = { ...state.cfg, fakes: list }
	try {
		void state.storage?.set?.({ fakes: list })?.catch?.(() => {})
	} catch {}
}

function fakes(): Fake[] {
	const list = state.cfg.fakes
	return Array.isArray(list) ? list.filter(f => f && f.channelId && f.id) : []
}

function remember(channelId: string, id: string) {
	saveFakes([...fakes(), { channelId, id }])
}

type MessageExtras = {
	imageUrl?: string
	embeds?: DiscordEmbed[]
	replyToId?: string
	replyToContent?: string
	replyToAuthor?: DiscordUser
	systemType?: number
}

function fakeMessage(
	channelId: string,
	user: DiscordUser,
	content: string,
	when?: number,
	extras: MessageExtras = {},
): string | null {
	const dispatch = flux()?.dispatch
	if (!dispatch || !channelId || !user?.id) return null
	const id = snowflake()
	const url = String(extras.imageUrl ?? '').trim()
	const attachments = url
		? [
				{
					id: '1',
					filename: 'image.png',
					size: 0,
					url,
					proxy_url: url,
					width: 800,
					height: 600,
					content_type: 'image/png',
				},
			]
		: []
	const message: DiscordMessage = {
		attachments,
		components: [],
		embeds: Array.isArray(extras.embeds) ? extras.embeds : [],
		mention_roles: [],
		mentions: [],
		author: author(user),
		channel_id: channelId,
		content: String(content ?? '').slice(0, 2000),
		edited_timestamp: null,
		flags: 0,
		id,
		nonce: id,
		pinned: false,
		timestamp: new Date(when ?? Date.now()).toISOString(),
		tts: false,
		type: extras.systemType ?? 0,
	}
	if (extras.replyToId) {
		message.message_reference = {
			channel_id: channelId,
			message_id: String(extras.replyToId),
		}
		message.referenced_message = {
			id: String(extras.replyToId),
			channel_id: channelId,
			content: String(extras.replyToContent ?? ''),
			author: author(extras.replyToAuthor ?? user),
			type: 0,
		}
	}
	dispatch({
		type: 'MESSAGE_CREATE',
		channelId,
		message,
		optimistic: false,
		isPushNotification: false,
	})
	remember(channelId, id)
	return id
}

function fakeCall(
	channelId: string,
	caller: DiscordUser,
	other: DiscordUser | null,
	seconds = 90,
	missed = false,
	at?: number,
): string | null {
	const dispatch = flux()?.dispatch
	if (!dispatch || !channelId || !caller?.id) return null
	const id = snowflake()
	const now = at ?? Date.now()
	const participants = missed
		? [String(caller.id)]
		: [String(caller.id), String(other?.id ?? '')].filter(Boolean)
	const message = {
		attachments: [],
		components: [],
		embeds: [],
		mention_roles: [],
		mentions: [],
		author: author(caller),
		channel_id: channelId,
		content: '',
		edited_timestamp: null,
		flags: 0,
		id,
		nonce: id,
		pinned: false,
		timestamp: new Date(now).toISOString(),
		tts: false,
		type: 3,
		call: {
			participants,
			ended_timestamp: new Date(
				now + (missed ? 0 : seconds * 1000),
			).toISOString(),
			duration: missed ? undefined : seconds,
		},
	}
	dispatch({
		type: 'MESSAGE_CREATE',
		channelId,
		message,
		optimistic: false,
		isPushNotification: false,
	})
	remember(channelId, id)
	return id
}

// System lines ("X joined the group", "X pinned a message"): same message shape
// as a normal one, only with a different type.
function fakeSystem(
	channelId: string,
	user: DiscordUser,
	type: number,
	content: string,
	at?: number,
): string | null {
	return fakeMessage(channelId, user, content, at, {
		systemType: Number(type) || 7,
	})
}

// The time the fake is stamped with: now, minus however many minutes the user
// picked. Negative and broken values fall back to now.
function when(): number {
	const minutes = Number(state.cfg.minutesAgo)
	if (!Number.isFinite(minutes) || minutes <= 0) return Date.now()
	return Date.now() - Math.round(minutes) * 60000
}

// A reaction from someone on a message. Discord keeps reactions beside the
// message, so this is dispatched as the reaction event, not a message.
function fakeReaction(
	channelId: string,
	messageId: string,
	userId: string,
	emoji: string,
): boolean {
	const dispatch = flux()?.dispatch
	const target = String(messageId ?? '').trim()
	const who = String(userId ?? '').trim()
	const name = String(emoji ?? '').trim()
	if (!dispatch || !channelId || !target || !who || !name) return false
	dispatch({
		type: 'MESSAGE_REACTION_ADD',
		channelId,
		messageId: target,
		userId: who,
		emoji: { name, id: null, animated: false },
	})
	return true
}

function clear(channelId: string): number {
	if (!channelId) return 0
	const dispatch = flux()?.dispatch
	const keep: Fake[] = []
	let removed = 0
	for (const f of fakes()) {
		if (f.channelId !== channelId) {
			keep.push(f)
			continue
		}
		try {
			dispatch?.({ type: 'MESSAGE_DELETE', channelId, id: f.id })
			removed++
		} catch {}
	}
	saveFakes(keep)
	return removed
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function embedFromConfig(): DiscordEmbed[] {
	const { embedTitle, embedDesc, embedImage } = state.cfg
	if (!embedTitle && !embedDesc && !embedImage) return []
	const embed: DiscordEmbed = {}
	if (embedTitle) embed.title = embedTitle
	if (embedDesc) embed.description = embedDesc
	if (embedImage) {
		embed.image = { url: embedImage, proxy_url: embedImage }
	}
	return [embed]
}

// The one action behind the chat-bar button.
function fake(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet.'
	const user = sender(chat)
	if (!user?.id) return 'No one to send as yet.'
	return fakeMessage(chat.id, user, state.cfg.text)
		? 'Sent a fake message.'
		: 'Discord is not ready yet.'
}

function fakeFromPanel(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const user = sender(chat)
	if (!user?.id) return 'No one to send as yet.'
	const id = fakeMessage(chat.id, user, state.cfg.text, when(), {
		imageUrl: state.cfg.imageUrl,
		embeds: embedFromConfig(),
		replyToId: state.cfg.replyId,
		replyToContent: 'a message in this chat',
		replyToAuthor: user,
	})
	return id
		? 'Sent as ' + (user.globalName || user.username || 'them') + '.'
		: 'Discord is not ready yet.'
}

// The two people on the call. The caller falls back to the chosen sender and
// the receiver to you, so a call works before anyone picks them by hand.
function callPeople(chat: Chat): {
	caller: DiscordUser | null
	receiver: DiscordUser | null
} {
	const mine = me()
	const caller = resolvePerson(chat, state.cfg.callerId) ?? sender(chat)
	const receiver = resolvePerson(chat, state.cfg.receiverId) ?? mine
	return { caller, receiver }
}

function fakeCallNow(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const { caller, receiver } = callPeople(chat)
	if (!caller?.id) return 'No one to send as yet.'
	const seconds = Math.max(0, Math.round(Number(state.cfg.callSeconds) || 0))
	const missed = !!state.cfg.callMissed
	return fakeCall(
		chat.id,
		caller,
		receiver,
		missed ? 0 : seconds,
		missed,
		when(),
	)
		? missed
			? 'Sent a missed call.'
			: 'Sent a fake call.'
		: 'Discord is not ready yet.'
}

function fakeMissedNow(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const { caller } = callPeople(chat)
	if (!caller?.id) return 'No one to send as yet.'
	return fakeCall(chat.id, caller, me(), 0, true, when())
		? 'Sent a missed call.'
		: 'Discord is not ready yet.'
}

function fakeSystemNow(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const user = sender(chat)
	if (!user?.id) return 'No one to send as yet.'
	const id = fakeSystem(
		chat.id,
		user,
		Number(state.cfg.systemType),
		state.cfg.systemText,
		when(),
	)
	return id ? 'Sent a system message.' : 'Discord is not ready yet.'
}

function fakeReactionNow(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	if (!String(state.cfg.reactId ?? '').trim())
		return 'Paste the id of a message first.'
	const ok = fakeReaction(
		chat.id,
		state.cfg.reactId,
		String(sender(chat)?.id ?? ''),
		state.cfg.reactEmoji,
	)
	return ok ? 'Added a fake reaction.' : 'Discord is not ready yet.'
}

// One message per line. "Name: text" picks the sender for that line, a plain
// line uses the chosen sender, and a leading [HH:MM] sets that line's time.
function parseBatch(text: string): BatchLine[] {
	const out: BatchLine[] = []
	for (const raw of String(text ?? '').split('\n')) {
		let line = raw.trim()
		if (!line) continue
		let time: number | undefined
		const clock = line.match(/^\[(\d{1,2}):(\d{2})\]\s*/)
		if (clock) {
			const when = new Date()
			when.setHours(
				Math.min(23, Number(clock[1])),
				Math.min(59, Number(clock[2])),
				0,
				0,
			)
			time = when.getTime()
			line = line.slice(clock[0].length).trim()
		}
		if (!line) continue
		const match = line.match(/^([^:]{1,40}):\s*(.+)$/)
		if (match) out.push({ name: match[1].trim(), content: match[2], time })
		else out.push({ name: '', content: line, time })
	}
	return out
}

// A whole conversation at once. Lines with a [HH:MM] land at that time today,
// the rest a little later than the one before so it reads like live typing.
function fakeBatch(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const lines = parseBatch(state.cfg.batch)
	if (!lines.length) return 'Nothing to send: put one message per line.'
	const fallback = sender(chat)
	let sent = 0
	let clock = when()
	for (const line of lines) {
		const who = resolvePerson(chat, line.name) ?? fallback
		if (!who?.id) continue
		const when = line.time ?? clock
		if (fakeMessage(chat.id, who, line.content, when)) sent++
		clock = when + 30000 + Math.floor(Math.random() * 90000)
	}
	return sent
		? 'Sent ' + sent + ' fake message(s).'
		: 'Nothing sent: no sender available.'
}

function clearNow(): string {
	const chat = openChat()
	if (!chat) return 'No chat found yet: open a DM, then tap "Find my chat".'
	const removed = clear(chat.id)
	return removed ? 'Removed ' + removed + ' fake(s).' : 'No fakes in this chat.'
}

// ─── Chat bar button ─────────────────────────────────────────────────────────
// This is how the shipped chat-bar plugins do it: Discord's own action button
// component is dropped into the chat input's button group with the `after`
// patcher. Nothing is invented, so the button looks and behaves like the
// built-in ones.
// Discord hands its icons a size; ours is drawn at that size, so it ends up the
// same weight as the emoji and microphone glyphs next to it.
type IconProps = { style?: unknown; size?: number }

function FakeIcon({ style, size }: IconProps = {}) {
	try {
		const side = typeof size === 'number' && size > 0 ? size : 24
		return (
			<Image
				source={{ uri: ICON }}
				style={[{ width: side, height: side }, style]}
			/>
		)
	} catch {
		return null
	}
}

function toast(text: string) {
	if (!text) return
	try {
		const actions = ToastActionCreators as unknown as {
			open?: (
				keyOrOptions: string | Record<string, unknown>,
				options?: Record<string, unknown>,
			) => void
		}
		if (typeof actions.open !== 'function') return
		try {
			actions.open('fakedm', { text, variant: 'default' })
		} catch {
			actions.open({ key: 'fakedm', content: text })
		}
	} catch {}
}

// Changing an option from the menu changes it for next time too, exactly like
// the settings page does.
function saveCfg(patch: Partial<typeof DEFAULTS>) {
	state.cfg = { ...DEFAULTS, ...(state.cfg ?? {}), ...patch }
	try {
		void state.storage?.set?.(patch)?.catch?.(() => {})
	} catch {}
}

type EditField =
	| {
			key: string
			label: string
			value: string
			multiline?: boolean
			numeric?: boolean
			people?: undefined
	  }
	| {
			key: string
			label: string
			value: string
			people: Array<{ id: string; name: string }>
			multiline?: undefined
			numeric?: undefined
	  }

// Everyone who can be on either side of a fake in the open chat, you first.
function chatPeople(): Array<{ id: string; name: string }> {
	const list: Array<{ id: string; name: string }> = []
	const you = me()
	if (you?.id)
		list.push({
			id: String(you.id),
			name: (you.globalName || you.username || 'You') + ' (you)',
		})
	const seen = new Set(list.map(person => person.id))
	let chat: Chat | null = null
	try {
		chat = openChat()
	} catch {}
	for (const user of [...(chat?.others ?? []), ...(chat?.members ?? [])]) {
		if (!user?.id || seen.has(String(user.id))) continue
		seen.add(String(user.id))
		list.push({
			id: String(user.id),
			name: user.globalName || user.username || String(user.id),
		})
	}
	return list
}

// The editor behind each menu entry: Discord's own dialog, using the same radio
// rows the settings page uses to pick a person, with Send as its action.
type EditorProps = {
	title: string
	fields: EditField[]
	onSend: (values: Record<string, string>) => string
}

function Editor({ title, fields, onSend }: EditorProps) {
	const D = designComponents()
	const start: Record<string, string> = {}
	for (const field of fields) start[field.key] = field.value
	const [values, setValues] = useState(start) as [
		Record<string, string>,
		(
			next:
				| Record<string, string>
				| ((prev: Record<string, string>) => Record<string, string>),
		) => void,
	]
	const [queries, setQueries] = useState({}) as [
		Record<string, string>,
		(
			next:
				| Record<string, string>
				| ((prev: Record<string, string>) => Record<string, string>),
		) => void,
	]
	const Alert = D.AlertModal
	const Action = D.AlertActionButton
	const RadioGroup = D.TableRadioGroup
	const RadioRow = D.TableRadioRow
	if (!Alert) return null

	const label = (field: EditField) =>
		createElement(
			Text,
			{
				style: {
					color: PALETTE.muted,
					fontSize: 12,
					fontWeight: '700',
					letterSpacing: 0.4,
					marginBottom: 6,
				},
			},
			field.label,
		)

	const peoplePicker = (field: EditField) => {
		const people: Array<{ id: string; name: string }> = field.people ?? []
		const chosen = values[field.key]
		const query = String(queries[field.key] ?? '')
		const chose = (next: string) =>
			setValues(prev => ({ ...prev, [field.key]: next }))
		const typed = (next: string) =>
			setQueries(prev => ({ ...prev, [field.key]: next }))
		const needle = query.trim().toLowerCase()
		const shown = needle
			? people.filter(
					person =>
						person.name.toLowerCase().includes(needle) ||
						person.id.includes(needle),
				)
			: people
		// A search box, for the chats where the list is long. It matches the
		// display name, the username inside it, and the id.
		const search = createElement(TextInput, {
			key: field.key + '-search',
			value: query,
			onChangeText: typed,
			placeholder: 'Search people',
			placeholderTextColor: PALETTE.muted,
			autoCorrect: false,
			style: {
				color: PALETTE.text,
				backgroundColor: PALETTE.input,
				borderRadius: 8,
				paddingHorizontal: 12,
				paddingVertical: 8,
				fontSize: 15,
				marginBottom: 8,
			},
		})
		const rows = (Group: ComponentLike, Row: ComponentLike) =>
			createElement(
				Group,
				{
					key: field.key + '-rows',
					title: field.label,
					value: chosen,
					onChange: chose,
				},
				...shown.map(person =>
					createElement(Row, {
						key: person.id,
						label: person.name,
						value: person.id,
						subLabel: chosen === person.id ? 'Selected' : 'Tap to pick',
					}),
				),
			)
		const byHand = () =>
			createElement(
				View,
				{
					key: field.key + '-rows',
					style: {
						backgroundColor: PALETTE.card,
						borderRadius: 12,
						padding: 12,
					},
				},
				label(field),
				...(shown.length
					? shown.map(person =>
							createElement(
								Pressable,
								{
									key: person.id,
									accessibilityRole: 'button',
									accessibilityLabel: person.name,
									onPress: () => chose(person.id),
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										paddingVertical: 9,
									},
								},
								createElement(
									Text,
									{ style: { color: PALETTE.text, flex: 1 } },
									person.name,
								),
								createElement(
									Text,
									{
										style: {
											color:
												chosen === person.id ? PALETTE.accent : PALETTE.muted,
										},
									},
									chosen === person.id ? '✓' : '',
								),
							),
						)
					: [
							createElement(
								Text,
								{ key: 'nobody', style: { color: PALETTE.muted } },
								'Nobody here yet',
							),
						]),
			)
		const body =
			RadioGroup && RadioRow && people.length
				? rows(RadioGroup, RadioRow)
				: byHand()
		return createElement(
			View,
			{ key: field.key, style: { marginTop: 12 } },
			RadioGroup && RadioRow && people.length ? null : null,
			search,
			body,
			needle && !shown.length
				? createElement(
						Text,
						{
							key: field.key + '-none',
							style: { color: PALETTE.muted, fontSize: 13, marginTop: 6 },
						},
						'Nobody matches "' + query.trim() + '".',
					)
				: null,
		)
	}

	const textField = (field: EditField) =>
		createElement(
			View,
			{ key: field.key, style: { marginTop: 12 } },
			label(field),
			createElement(TextInput, {
				value: values[field.key],
				onChangeText: (next: string) =>
					setValues(prev => ({ ...prev, [field.key]: next })),
				multiline: !!field.multiline,
				keyboardType: field.numeric ? 'numeric' : 'default',
				placeholderTextColor: PALETTE.muted,
				style: {
					color: PALETTE.text,
					backgroundColor: PALETTE.input,
					borderRadius: 8,
					paddingHorizontal: 12,
					paddingVertical: 10,
					fontSize: 16,
					minHeight: field.multiline ? 88 : 0,
					textAlignVertical: field.multiline ? 'top' : 'center',
				},
			}),
		)

	const content = createElement(
		View,
		{ style: { width: '100%' } },
		...(fields as EditField[]).map(field =>
			field.people ? peoplePicker(field) : textField(field),
		),
	)

	return createElement(Alert, {
		title,
		content,
		actions: Action
			? createElement(Action, {
					text: 'Send',
					onPress: () => toast(onSend(values)),
				})
			: undefined,
	})
}

let editors = 0

// Returns whether the dialog opened, so the caller can send straight away on a
// build that never had one.
function openEditor(
	title: string,
	fields: EditField[],
	onSend: (values: Record<string, string>) => string,
): boolean {
	try {
		const actions = AlertActionCreators as unknown as {
			openAlert?: (key: string, content: Element) => void
		}
		if (typeof actions.openAlert !== 'function') return false
		editors += 1
		actions.openAlert(
			'fakedm-editor-' + editors,
			createElement(Editor, { title, fields, onSend }),
		)
		return true
	} catch {
		return false
	}
}

// One menu entry: open the editor for this action, or do it with the saved
// settings when the dialog cannot be shown.
function edit(
	title: string,
	fields: EditField[],
	onSend: (values: Record<string, string>) => string,
) {
	return () => {
		if (openEditor(title, fields, onSend)) return
		const start: Record<string, string> = {}
		for (const field of fields) start[field.key] = field.value
		try {
			toast(onSend(start))
		} catch (error) {
			toast('Failed: ' + errorMessage(error))
		}
	}
}

// A value that is only for this send; the saved setting goes back afterwards.
function withSetting<T>(
	key: 'callerId' | 'senderId',
	value: string,
	task: () => T,
): T {
	const before = state.cfg[key]
	state.cfg = { ...state.cfg, [key]: value } as typeof state.cfg
	try {
		return task()
	} finally {
		state.cfg = { ...state.cfg, [key]: before } as typeof state.cfg
	}
}

// What the chat-bar button opens: one entry per thing the plugin can do to the
// chat you are in, each one editable before it is sent.
function menuItems(): Array<{ label: string; action: () => void }> {
	const people = () => chatPeople()
	const youAs = () => {
		const list = people()
		return (
			state.cfg.senderId ||
			list.find(person => / \(you\)$/.test(person.name))?.id ||
			list[0]?.id ||
			''
		)
	}
	const whoCalls = () => state.cfg.callerId || people()[0]?.id || ''
	return [
		{
			label: 'Send the message',
			action: edit(
				'Send the message',
				[
					{ key: 'as', label: 'Send as', value: youAs(), people: people() },
					{
						key: 'text',
						label: 'Message',
						value: state.cfg.text,
						multiline: true,
					},
				],
				values => {
					saveCfg({ text: values.text })
					return withSetting('senderId', String(values.as ?? ''), fakeFromPanel)
				},
			),
		},
		{
			label: 'Send a call',
			action: edit(
				'Send a call',
				[
					{
						key: 'from',
						label: 'Who calls',
						value: whoCalls(),
						people: people(),
					},
					{
						key: 'seconds',
						label: 'Seconds it lasted',
						value: String(state.cfg.callSeconds),
						numeric: true,
					},
				],
				values => {
					saveCfg({ callSeconds: String(values.seconds ?? '') })
					return withSetting('callerId', String(values.from ?? ''), fakeCallNow)
				},
			),
		},
		{
			label: 'Send a missed call',
			action: edit(
				'Send a missed call',
				[
					{
						key: 'from',
						label: 'Who called',
						value: whoCalls(),
						people: people(),
					},
				],
				values =>
					withSetting('callerId', String(values.from ?? ''), fakeMissedNow),
			),
		},
		{
			label: 'Send the batch',
			action: edit(
				'Send the batch',
				[
					{ key: 'as', label: 'Send as', value: youAs(), people: people() },
					{
						key: 'batch',
						label: 'One message per line',
						value: state.cfg.batch,
						multiline: true,
					},
				],
				values => {
					saveCfg({ batch: values.batch })
					return withSetting('senderId', String(values.as ?? ''), fakeBatch)
				},
			),
		},
		{
			label: 'Add a reaction',
			action: edit(
				'Add a reaction',
				[
					{ key: 'as', label: 'Who reacts', value: youAs(), people: people() },
					{ key: 'emoji', label: 'Emoji', value: state.cfg.reactEmoji },
					{ key: 'message', label: 'Message id', value: state.cfg.reactId },
				],
				values => {
					saveCfg({ reactEmoji: values.emoji, reactId: values.message })
					return withSetting(
						'senderId',
						String(values.as ?? ''),
						fakeReactionNow,
					)
				},
			),
		},
		{
			label: 'Clear fakes here',
			action: edit('Clear fakes here', [], () => clearNow()),
		},
	]
}

// Discord's menu component, from the design barrel or from the module that
// exports it (the barrel does not carry it on every build).
type ElementLike = { props?: Record<string, unknown>; key?: string | null }

function asElement(node: unknown): ElementLike | null {
	return isRecord(node) ? (node as ElementLike) : null
}

function contextMenuComponent(): ComponentLike | null {
	const fromDesign = designComponents().ContextMenu
	if (typeof fromDesign === 'function') return fromDesign
	try {
		const found = (
			lookupModule(withProps('ContextMenu') as never) as unknown[]
		)[0]
		const mod = isRecord(found) ? found : null
		const component = mod?.ContextMenu ?? mod?.default
		return typeof component === 'function' ? (component as ComponentLike) : null
	} catch {
		return null
	}
}

// The button for one render: a clone of Discord's own, wrapped in its menu when
// the client offers one, so a tap lists everything FakeDM can send.
function findButtonTemplate(node: unknown): Element | null {
	if (!isValidElement(node)) return null
	const element = asElement(node)
	const props = asRecord(element?.props)
	if (props.__fakedm === true || element?.key === 'fakedm') return null
	if (typeof props.IconComponent === 'function') return node as Element
	const kids = props.children
	for (const child of Array.isArray(kids) ? kids : [kids]) {
		const hit = findButtonTemplate(child)
		if (hit) return hit
	}
	return null
}

function buttonFor(tree: Element | null): Element | null {
	if (typeof createElement !== 'function') return null
	try {
		const template = findButtonTemplate(tree)
		const press = () => {
			try {
				fake()
			} catch {}
		}
		const render = (props: Record<string, unknown> = {}) =>
			template
				? (cloneElement(template, {
						...props,
						key: 'fakedm',
						__fakedm: true,
						accessibilityLabel: 'FakeDM',
						IconComponent: FakeIcon,
					} as never) as Element)
				: null
		const ContextMenu = contextMenuComponent()
		if (template) {
			state.buttonKind = 'discord'
			if (typeof ContextMenu === 'function') {
				return createElement(
					ContextMenu,
					{ align: 'above', triggerOnTap: true, items: menuItems() },
					render,
				)
			}
			return render({ onPress: press })
		}
		return buildButton()
	} catch {
		return null
	}
}

// Built once, at start, never during a render: the chat input's render method
// is the one place where an exception takes the whole screen down with it.
function buildButton(): Element | null {
	if (typeof createElement !== 'function') return null
	const press = () => {
		try {
			fake()
		} catch {}
	}
	const ContextMenu = designComponents().ContextMenu
	try {
		if (state.actionButton) {
			state.buttonKind = 'discord'
			// Discord's own button, drawn with our icon. Where the client ships
			// ContextMenu the tap opens a menu of what FakeDM can send; without
			// it the tap sends the message straight away.
			const ActionButton = state.actionButton
			const button = (props: Record<string, unknown> = {}) =>
				createElement(
					ActionButton as never,
					{
						...props,
						accessibilityLabel: 'FakeDM',
						IconComponent: FakeIcon,
					} as never,
				)
			if (typeof ContextMenu === 'function') {
				return createElement(
					ContextMenu,
					{ align: 'above', triggerOnTap: true, items: menuItems() },
					button,
				)
			}
			return button({ onPress: press })
		}
		state.buttonKind = 'plain'
		// No Discord button module on this build: a plain pressable still sits
		// in the row and still works, it just is not styled by Discord.
		return createElement(
			Pressable,
			{
				accessibilityLabel: 'FakeDM',
				accessibilityRole: 'button',
				onPress: press,
				style: { paddingHorizontal: 10, paddingVertical: 6 },
			},
			createElement(FakeIcon, {}),
		)
	} catch {
		return null
	}
}

const propsOf = (node: unknown): Record<string, unknown> =>
	asRecord(asElement(node)?.props)
const hasExpression = (node: unknown): boolean =>
	isValidElement(node) && Boolean(propsOf(node).onPressExpression)
const hasKey = (node: unknown): boolean =>
	isValidElement(node) &&
	(propsOf(node).__fakedm === true || asElement(node)?.key === 'fakedm')

// A button group is the element whose children hold the chat input's own
// buttons (they carry an onPressExpression).
function isButtonGroup(node: unknown): boolean {
	if (!isValidElement(node)) return false
	const kids = propsOf(node).children
	if (hasExpression(kids)) return true
	if (!isValidElement(kids)) return false
	const inner = propsOf(kids).children
	return Array.isArray(inner) ? inner.some(hasExpression) : hasExpression(inner)
}

// Inserts the button into that group, after Discord's own buttons: on this
// client the right-hand buttons (emoji, microphone) are the last items, so the
// Fake button sits beside them instead of on the attachment side.
function addButton(node: unknown, button: Element | null): unknown {
	if (!button || !isValidElement(node)) return node
	const element = asElement(node)
	const props = asRecord(element?.props)
	const children = props.children
	const list = Array.isArray(children) ? [...children] : [children]
	if (list.some(hasKey)) return node

	// Just before the group holding the chat input's own buttons, which is
	// where the other chat-bar plugins put theirs.
	const at = list.findIndex(isButtonGroup)
	if (at !== -1) {
		list.splice(at, 0, button)
		return { ...(node as object), props: { ...props, children: list } }
	}

	let last = -1
	list.forEach((child, index) => {
		if (hasExpression(child)) last = index
	})
	if (last !== -1) {
		list.splice(last + 1, 0, button)
		return { ...(node as object), props: { ...props, children: list } }
	}

	for (let i = 0; i < list.length; i++) {
		const child = list[i]
		const patched = addButton(child, button)
		if (patched === child) continue
		const next = [...list]
		next[i] = patched
		return {
			...(node as object),
			props: { ...props, children: Array.isArray(children) ? next : patched },
		}
	}
	return node
}

// Two ways to reach a module: the file it was imported from, and the name of
// the component. Builds differ in which one survives their optimiser, so both
// are tried and the diagnostics page says which one answered.
// Every module path this plugin knows about, reported on the diagnostics page
// together with whether it resolves on the running client. When the button is
// missing this is the line that says why.
// Every path the running client has recorded, which is the only reliable source
// for where a module actually lives: Discord renames files between releases, and
// a hardcoded path that no longer exists looks exactly like "plugin broken".
// The finders can hang off the global, off `api.unscoped`, or off `api`
// itself; which one is populated differs between Valenced builds, so all three
// are tried once at start and the first live one is kept.
interface PluginApiLike {
	unscoped?: { discord?: { utils?: { modules?: { finders?: ModuleFinders } } } }
	discord?: { utils?: { modules?: { finders?: ModuleFinders } } }
	jsonStorage?: JsonStorage<typeof DEFAULTS>
	cleanup?: (fn: () => void) => void
	logger?: Logger
}

function pickFinders(api: PluginApiLike | null): ModuleFinders | null {
	const fromApi =
		api?.unscoped?.discord?.utils?.modules?.finders ??
		api?.discord?.utils?.modules?.finders
	const globalFinders = isRecord(globalThis)
		? asRecord((globalThis as Record<string, unknown>).valenced)
		: {}
	const fromGlobal = asRecord(
		asRecord(asRecord(asRecord(globalFinders.discord).utils).modules).finders,
	)
	const candidates: unknown[] = [PathFinders, fromApi, fromGlobal]
	for (const candidate of candidates) {
		if (
			isRecord(candidate) &&
			typeof candidate.getModuleWithImportedPath === 'function'
		) {
			return candidate as ModuleFinders
		}
	}
	return null
}

function finders(): ModuleFinders | null {
	if (state.finders) return state.finders
	return pickFinders(null)
}

function importedPaths(): string[] {
	try {
		const source = (ImportTracker as unknown as { mImportedPaths?: unknown })
			.mImportedPaths
		if (!(source instanceof Map)) return []
		const out: string[] = []
		source.forEach(value => {
			if (typeof value === 'string') out.push(value)
		})
		return out
	} catch {
		return []
	}
}

// The first recorded path that ends like one of the candidates, so a renamed
// directory still matches, and the known path as the last resort.
function resolvePath(candidates: string[], fallback: string): string {
	const paths = importedPaths()
	for (const candidate of candidates) {
		const hit = paths.find(
			path => path === candidate || path.endsWith('/' + candidate),
		)
		if (hit) return hit
	}
	return fallback
}

const INPUT_CANDIDATES = [
	'native/ChatInput.tsx',
	'ChatInput.tsx',
	'native/ChatInput.ts',
]
const BUTTON_CANDIDATES = [
	'action_buttons/ChatInputActionButton.tsx',
	'ChatInputActionButton.tsx',
]

// Discord keeps the name on its memoised chat-bar components, and the community
// chat-button plugins find them this way. It is the only route that works on a
// client that does not record its import map (this one reports 0 paths), so it
// is used alongside the path lookups instead of instead of them.
interface ModuleExports {
	type?: { displayName?: string }
	default?: unknown
}

const withComponentName = (() => {
	try {
		const make = createFilterGenerator as unknown as (
			filter: (
				args: [string],
				scopes: unknown,
				exports: ModuleExports,
			) => boolean,
			describe: (args: [string]) => string,
		) => (name: string) => unknown
		if (typeof make !== 'function') return null
		return make(
			([name], _scopes, exported) =>
				Boolean(exported?.type) &&
				(exported.type as { displayName?: string }).displayName === name,
			([name]) => `component(${name})`,
		)
	} catch {
		return null
	}
})()

// getModules keeps listening, so a component that Discord loads when the chat
// first opens is picked up then, not only if it happens to exist already.
function watchComponent(
	name: string,
	done: (mod: ModuleExports) => void,
	cleanup: (fn: () => void) => void,
): boolean {
	if (!withComponentName) return false
	try {
		const finder = getModules as unknown as (
			filter: unknown,
			callback: (mod: ModuleExports) => void,
			options: { max: number },
		) => unknown
		const stop = finder(
			withComponentName(name),
			mod => {
				try {
					done(mod)
				} catch {}
			},
			{ max: 1 },
		)
		if (typeof stop === 'function') cleanup(stop as () => void)
		return true
	} catch {
		return false
	}
}

const PROBE_PATHS = [
	INPUT_PATH,
	BUTTON_PATH,
	'modules/chat_input/native/action_buttons/ChatInputRightActions.tsx',
	'modules/chat_input/native/action_buttons/ChatInputActions.tsx',
]

function probePaths(): Array<{ path: string; found: boolean }> {
	return PROBE_PATHS.map(path => {
		try {
			const [mod] = finders()?.lookupModuleWithImportedPath?.(path) ?? []
			return { path, found: Boolean(mod) }
		} catch {
			return { path, found: false }
		}
	})
}

function moduleFromPath(path: string): ModuleWithType | null {
	try {
		const [mod] = finders()?.lookupModuleWithImportedPath?.(path) ?? []
		if (!mod) return null
		return isRecord(mod) ? (mod as ModuleWithType) : null
	} catch {
		return null
	}
}

function moduleByName(name: string): ModuleWithType | null {
	try {
		const [found] = (lookupModule(withName(name) as never) as unknown[]) ?? []
		return isRecord(found) ? (found as ModuleWithType) : null
	} catch {
		return null
	}
}

// Both the chat input and its action button are lazy modules: nothing is in
// the registry until the chat screen is opened for the first time. So the
// lookup runs again every time a module initializes, and the button appears as
// soon as a chat is opened instead of never.
// The client hands modules over through a callback once they exist; that is how
// the shipped chat-bar plugins reach the chat input, and the synchronous lookup
// alone misses them.
function onModule(
	path: string,
	callback: (mod: ModuleWithType) => void,
	cleanup: (fn: () => void) => void,
): boolean {
	try {
		const finder = finders()?.getModuleWithImportedPath
		if (typeof finder !== 'function') return false
		const off = finder(path, mod => {
			try {
				callback(mod)
			} catch {}
		})
		if (typeof off === 'function') cleanup(off)
		return true
	} catch {
		return false
	}
}

function buttonFromModule(mod: ModuleWithType | null): ButtonComponent | null {
	if (!mod) return null
	const candidate = mod.default ?? mod
	return typeof candidate === 'function' ? (candidate as ButtonComponent) : null
}

// Module finders hand back either the module itself or an ES module
// namespace whose `default` is the module. Both spellings show up depending on
// the client build, so unwrap until a `type` component is in reach.
function moduleWithType(mod: ModuleWithType | null): ModuleWithType | null {
	if (!mod) return null
	if (typeof mod.type === 'function') return mod
	const inner = asRecord(mod.default)
	return typeof inner?.type === 'function' ? (inner as ModuleWithType) : null
}

function installPatch(
	ChatInput: ModuleWithType,
	cleanup: (fn: () => void) => void,
	logger?: Logger,
): boolean {
	if (state.patched) return true
	const component = moduleWithType(ChatInput)
	if (!component) return false
	try {
		// The hook is handed (args, result) on current builds; older ones pass
		// the rendered element first. Whatever goes wrong, Discord's own
		// element is returned: a throw here would take the chat screen down.
		cleanup(
			after(component, 'type', (...params: unknown[]) => {
				let result: unknown = params[1] ?? params[0]
				try {
					const rendered = params.find(value => isValidElement?.(value))
					if (rendered) result = rendered
					if (state.cfg.button === false) return result
					const button = buttonFor(result as Element | null)
					if (!button) return result
					return addButton(result, button)
				} catch (error) {
					logger?.warn?.('[FakeDM] chat button skipped this render', error)
					return result
				}
			}),
		)
		state.patched = true
		logger?.log?.('[FakeDM] chat button installed; open a chat to see it.')
		return true
	} catch (error) {
		logger?.error?.('[FakeDM] could not patch the chat input', error)
		return false
	}
}

function tryAttach(
	cleanup: (fn: () => void) => void,
	logger?: Logger,
): boolean {
	if (state.patched) return true

	const buttonPath = resolvePath(BUTTON_CANDIDATES, BUTTON_PATH)
	const inputPath = resolvePath(INPUT_CANDIDATES, INPUT_PATH)
	state.diag.buttonPath = buttonPath
	state.diag.inputPath = inputPath

	if (!state.actionButton) {
		state.actionButton = buttonFromModule(moduleFromPath(buttonPath))
		state.diag.button = state.actionButton ? 'path' : ''
		if (!state.actionButton) {
			// Callback form: runs the moment the button module exists.
			onModule(
				buttonPath,
				mod => {
					const found = buttonFromModule(mod)
					if (!found || state.actionButton) return
					state.actionButton = found
					state.diag.button = 'callback'
					if (!state.button || state.buttonKind !== 'discord')
						state.button = buildButton()
				},
				cleanup,
			)
		}
		if (!state.actionButton) {
			state.actionButton = buttonFromModule(
				moduleByName('ChatInputActionButton'),
			)
			state.diag.button = state.actionButton ? 'name' : ''
		}
		if (!state.actionButton) {
			// The route that works on builds without an import map.
			watchComponent(
				'ChatInputActionButton',
				mod => {
					const found = buttonFromModule(mod)
					if (!found || state.actionButton) return
					state.actionButton = found
					state.diag.button = 'display'
					if (!state.button || state.buttonKind !== 'discord')
						state.button = buildButton()
				},
				cleanup,
			)
		}
	}
	// A plain button built before the real module appeared is replaced as soon
	// as Discord's own button can be found.
	if (!state.button || (state.actionButton && state.buttonKind !== 'discord'))
		state.button = buildButton()

	let ChatInput = moduleFromPath(inputPath)
	const describe = (mod: ModuleWithType | null): string =>
		String(
			(mod as { displayName?: string; name?: string } | null)?.displayName ??
				(mod as { name?: string } | null)?.name ??
				'anonymous',
		)
	state.diag.input = ChatInput ? 'path' : ''
	state.diag.inputName = ChatInput ? describe(ChatInput) : ''

	if (!ChatInput) {
		ChatInput = moduleByName('ChatInput')
		state.diag.input = ChatInput ? 'name' : ''
	}
	if (ChatInput) return installPatch(ChatInput, cleanup, logger)

	// Same fallback for the input: patched by component name, which the client
	// hands over the moment the chat screen first renders.
	if (!state.watchingByNameInput && withComponentName) {
		state.watchingByNameInput = true
		watchComponent(
			'ChatInput',
			mod => {
				const found =
					typeof mod.type === 'function'
						? mod
						: isRecord(mod.default)
							? (mod.default as ModuleWithType)
							: mod
				state.diag.input = 'display'
				state.diag.inputName = String(mod.type?.displayName ?? 'ChatInput')
				installPatch(found, cleanup, logger)
			},
			cleanup,
		)
	}

	// Not in the registry yet: ask to be told when it is.
	if (!state.watchingInput) {
		state.watchingInput = true
		onModule(
			inputPath,
			mod => {
				const found = isRecord(mod.default)
					? (mod.default as ModuleWithType)
					: mod
				state.diag.input = 'callback'
				state.diag.inputName = describe(found)
				installPatch(found, cleanup, logger)
			},
			cleanup,
		)
	}
	return state.patched
}

function patchChatInput(cleanup: (fn: () => void) => void, logger?: Logger) {
	if (state.cfg.button === false) {
		logger?.log?.(
			'[FakeDM] chat bar button is off; the chat input is left alone.',
		)
		return
	}

	if (tryAttach(cleanup, logger)) return

	// Watch the module runtime: every time something initializes, look again.
	const metro = Metro as unknown as {
		onAnyModuleInitialized?: (callback: () => void) => (() => void) | void
		onAnyModuleFirstRequired?: (callback: () => void) => (() => void) | void
	}
	const watch = metro?.onAnyModuleInitialized ?? metro?.onAnyModuleFirstRequired
	if (typeof watch === 'function') {
		try {
			let tries = 0
			let off: (() => void) | null = null
			const stop = watch(() => {
				if (state.patched) {
					try {
						off?.()
					} catch {}
					return
				}
				if (++tries > 500) {
					try {
						off?.()
					} catch {}
					return
				}
				tryAttach(cleanup, logger)
			})
			off = typeof stop === 'function' ? stop : null
			if (off) cleanup(off)
			return
		} catch (error) {
			logger?.warn?.('[FakeDM] module watch unavailable', error)
		}
	}

	// No module events on this build: retry on a timer for a minute instead.
	let left = 40
	const timer = setInterval(() => {
		if (state.patched || --left <= 0) {
			clearInterval(timer)
			return
		}
		tryAttach(cleanup, logger)
	}, 1500)
	cleanup(() => clearInterval(timer))
}

// ─── Settings page ───────────────────────────────────────────────────────────
// The page is drawn out of Discord's own settings components — the same
// TableRowGroup / TableRow / TableSwitchRow / TableRadioGroup rows that the
// Math plugin and Discord's own settings screens use — so it looks like part of
// the client instead of a custom form. Text fields stay on React Native's
// TextInput, because the design one swallows typing on 352.x. Every component is
// looked up on each render and falls back to a plain view when a build does not
// ship it, so the page never disappears.
// Colours come from Discord's tokens, not from a palette: the page has to work on
// dark, AMOLED and light without a second set of values.
const PALETTE = {
	get text() {
		return token('TEXT_NORMAL')
	},
	get muted() {
		return token('TEXT_MUTED')
	},
	get accent() {
		return token('BRAND_500')
	},
	get card() {
		return token('BACKGROUND_SECONDARY')
	},
	get input() {
		return token('BACKGROUND_TERTIARY')
	},
}

const WHEN_CHOICES = [
	{ label: 'Now', minutes: '0' },
	{ label: '5 minutes ago', minutes: '5' },
	{ label: '1 hour ago', minutes: '60' },
	{ label: '3 hours ago', minutes: '180' },
	{ label: 'Yesterday', minutes: '1440' },
]

type Entry = { value: string; label: string; subLabel?: string }

function Panel({ api }: { api?: PluginApiLike } = {}) {
	const [, bump] = useState(0) as [
		number,
		(next: number | ((prev: number) => number)) => void,
	]
	const [status, setStatus] = useState('') as [string, (next: string) => void]
	const settings = state.cfg ?? DEFAULTS
	const store = api?.jsonStorage ?? state.storage

	const D = designComponents()
	const Group = D.TableRowGroup
	const Row = D.TableRow
	const SwitchRow = D.TableSwitchRow
	const RadioGroup = D.TableRadioGroup
	const RadioRow = D.TableRadioRow
	const DText = D.Text
	const StackView = D.Stack ?? View

	const set = (patch: Partial<typeof DEFAULTS>) => {
		state.cfg = { ...state.cfg, ...patch }
		try {
			void store?.set?.(patch)?.catch?.(() => {})
		} catch {}
		bump(n => n + 1)
	}

	const run = (fn: () => string) => {
		try {
			setStatus(fn())
		} catch (error) {
			setStatus('Failed: ' + errorMessage(error))
		}
	}

	let chat: Chat | null = null
	try {
		chat = openChat()
	} catch {}

	const mine = (() => {
		try {
			return me()
		} catch {
			return null
		}
	})()

	const people: Array<{ id: string; name: string }> = []
	const seen = new Set<string>()
	for (const user of [...(chat?.others ?? []), ...(chat?.members ?? [])]) {
		if (!user?.id || seen.has(String(user.id))) continue
		if (mine?.id && String(user.id) === String(mine.id)) continue
		seen.add(String(user.id))
		people.push({
			id: String(user.id),
			name: user.globalName || user.username || String(user.id),
		})
	}
	if (mine?.id) people.push({ id: String(mine.id), name: 'You' })

	const chosen = String(
		settings.senderId ||
			(settings.asThem ? people[0]?.id : mine?.id) ||
			people[0]?.id ||
			'',
	)
	const senderName = people.find(p => p.id === chosen)?.name ?? 'nobody'
	const on = settings.button !== false
	const cat = state.cat
	const callerId = String(settings.callerId || chosen || '')
	const receiverId = String(settings.receiverId || mine?.id || '')
	const nameOf = (id: string) => people.find(p => p.id === id)?.name ?? 'nobody'

	// A section is one of Discord's row groups; without the component it is the
	// same content on a plain card.
	const section = (title: string, children: Element | null) =>
		Group ? (
			<Group key={title} title={title}>
				<View style={{ gap: 10, padding: 16 }}>{children}</View>
			</Group>
		) : (
			<View
				key={title}
				style={{
					backgroundColor: PALETTE.card,
					borderRadius: 12,
					padding: 12,
					gap: 10,
				}}
			>
				<Text
					style={{
						color: PALETTE.muted,
						fontSize: 12,
						fontWeight: '700',
						letterSpacing: 0.4,
					}}
				>
					{title}
				</Text>
				{children}
			</View>
		)

	// A read-only line: label on top, detail underneath, like every Discord row.
	const info = (label: string, subLabel: string) =>
		Row ? (
			<Row key={label} label={label} subLabel={subLabel} />
		) : (
			<View key={label} style={{ paddingVertical: 6 }}>
				<Text style={{ color: PALETTE.text, fontWeight: '600' }}>{label}</Text>
				<Text style={{ color: PALETTE.muted, fontSize: 12 }}>{subLabel}</Text>
			</View>
		)

	const hint = (text: string) =>
		DText ? (
			<DText variant="text-xs/medium">{text}</DText>
		) : (
			<Text style={{ color: PALETTE.muted, fontSize: 12 }}>{text}</Text>
		)

	// A row that does something, with Discord's chevron when the rows exist.
	const action = (label: string, subLabel: string, onPress: () => void) =>
		Row ? (
			<Row
				key={label}
				label={label}
				subLabel={subLabel}
				arrow
				onPress={onPress}
			/>
		) : (
			<Pressable
				key={label}
				accessibilityRole="button"
				accessibilityLabel={label}
				onPress={onPress}
				style={{
					backgroundColor: PALETTE.input,
					borderRadius: 10,
					paddingVertical: 12,
					alignItems: 'center',
				}}
			>
				<Text style={{ color: PALETTE.text, fontWeight: '700' }}>{label}</Text>
			</Pressable>
		)

	const field = (
		key: keyof typeof DEFAULTS,
		placeholder: string,
		options: { multiline?: boolean; numeric?: boolean } = {},
	) => (
		<TextInput
			key={key}
			value={String(settings[key] ?? '')}
			onChangeText={(value: string) =>
				set({ [key]: value } as Partial<typeof DEFAULTS>)
			}
			placeholder={placeholder}
			placeholderTextColor={PALETTE.muted}
			multiline={!!options.multiline}
			keyboardType={options.numeric ? 'number-pad' : 'default'}
			style={{
				color: PALETTE.text,
				backgroundColor: PALETTE.input,
				borderRadius: 8,
				paddingHorizontal: 12,
				paddingVertical: 10,
				minHeight: options.multiline ? 96 : 0,
				textAlignVertical: options.multiline ? 'top' : 'center',
			}}
		/>
	)

	// A one-of-many choice: Discord's radio rows where they exist.
	const pick = (
		title: string,
		value: string,
		entries: Entry[],
		onPick: (value: string) => void,
	) =>
		RadioGroup && RadioRow && entries.length ? (
			<RadioGroup key={title} title={title} value={value} onChange={onPick}>
				{entries.map(entry => (
					<RadioRow
						key={entry.value}
						label={entry.label}
						subLabel={entry.subLabel}
						value={entry.value}
					/>
				))}
			</RadioGroup>
		) : (
			<View
				key={title}
				style={{
					backgroundColor: PALETTE.card,
					borderRadius: 12,
					padding: 12,
					gap: 2,
				}}
			>
				<Text
					style={{
						color: PALETTE.muted,
						fontSize: 12,
						fontWeight: '700',
						letterSpacing: 0.4,
					}}
				>
					{title}
				</Text>
				{entries.length ? (
					entries.map(entry => (
						<Pressable
							key={entry.value}
							accessibilityRole="button"
							accessibilityLabel={entry.label}
							onPress={() => onPick(entry.value)}
							style={{
								flexDirection: 'row',
								alignItems: 'center',
								gap: 8,
								paddingVertical: 9,
							}}
						>
							<Text style={{ color: PALETTE.text, flex: 1 }}>
								{entry.label}
							</Text>
							<Text
								style={{
									color: value === entry.value ? PALETTE.accent : PALETTE.muted,
								}}
							>
								{value === entry.value ? '✓' : ''}
							</Text>
						</Pressable>
					))
				) : (
					<Text style={{ color: PALETTE.muted, paddingVertical: 9 }}>
						Nobody here yet
					</Text>
				)}
			</View>
		)

	// People appear in three places; each says what picking one does.
	const personEntries = (
		selected: string,
		idle: string,
		picked?: string,
	): Entry[] =>
		people.map(person => ({
			value: person.id,
			label: person.name,
			subLabel: selected === person.id ? (picked ?? 'Selected') : idle,
		}))

	const findChat = () => {
		const manual = String(settings.chatId ?? '').trim()
		if (manual) {
			const found = channelById(manual)
			return found
				? 'Using ' + (found.name || 'chat ' + manual) + '.'
				: 'No chat with that id — check the id and try again.'
		}
		const id = currentChannelId()
		return id
			? 'Found chat ' + id + '.'
			: 'Discord reported no open chat. Paste its id below.'
	}

	// Times the desktop plugin offers through a date picker, as one tap each
	// plus a box for anything else.
	const whenBlock = () => (
		<>
			{pick(
				'When',
				String(settings.minutesAgo),
				WHEN_CHOICES.map(choice => ({
					value: choice.minutes,
					label: choice.label,
					subLabel:
						String(settings.minutesAgo) === choice.minutes
							? 'Selected'
							: undefined,
				})),
				minutes => set({ minutesAgo: minutes }),
			)}
			{section(
				'Another time',
				field('minutesAgo', 'Minutes ago (0 = now)', { numeric: true }),
			)}
		</>
	)

	const messagePage = (
		<>
			{pick(
				'Send as',
				chosen,
				personEntries(chosen, 'Tap to send as them', 'Sending as them'),
				id => set({ senderId: id }),
			)}
			{section('Message', field('text', 'Message', { multiline: true }))}
			{section(
				'Extras',
				<>
					{field('imageUrl', 'Image URL (optional)')}
					{field('replyId', 'Reply to message ID (optional)')}
					{field('embedTitle', 'Embed title (optional)')}
					{field('embedDesc', 'Embed description (optional)', {
						multiline: true,
					})}
					{field('embedImage', 'Embed image URL (optional)')}
				</>,
			)}
			{section(
				'Send',
				action(
					'Send as ' + senderName,
					'Posts into the chat you have open, as them',
					() => run(fakeFromPanel),
				),
			)}
			{whenBlock()}
		</>
	)

	const callPage = (
		<>
			{pick(
				'Caller',
				callerId,
				personEntries(callerId, 'Tap to pick the caller'),
				id => set({ callerId: id }),
			)}
			{pick(
				'Receiver',
				receiverId,
				personEntries(receiverId, 'Tap to pick who receives it'),
				id => set({ receiverId: id }),
			)}
			{section(
				'Call details',
				<>
					{hint(
						'A call from ' +
							nameOf(callerId) +
							' to ' +
							nameOf(receiverId) +
							'.',
					)}
					{field('callSeconds', 'Duration in seconds', { numeric: true })}
				</>,
			)}
			{section(
				'Send',
				<>
					{action('Send fake call', 'Rings in the chat you have open', () =>
						run(fakeCallNow),
					)}
					{action('Send missed call', 'A call they did not pick up', () =>
						run(fakeMissedNow),
					)}
				</>,
			)}
			{whenBlock()}
		</>
	)

	const batchPage = (
		<>
			{section(
				'Batch',
				<>
					{hint(
						'One message per line. "Name: text" picks who says it, and a leading [14:30] sets the time.',
					)}
					{field('batch', '[14:30] Alice: hey\n[14:31] Bob: hi there\nsure', {
						multiline: true,
					})}
				</>,
			)}
			{section(
				'Send',
				action('Send batch', 'Every line lands in order', () => run(fakeBatch)),
			)}
		</>
	)

	const systemPage = (
		<>
			{pick(
				'Who it is from',
				chosen,
				personEntries(chosen, 'Tap to send as them', 'Sending as them'),
				id => set({ senderId: id }),
			)}
			{pick(
				'System message',
				String(settings.systemType),
				SYSTEM_TYPES.map(type => ({
					value: String(type.value),
					label: type.label,
					subLabel:
						Number(settings.systemType) === type.value ? 'Selected' : undefined,
				})),
				value => set({ systemType: Number(value) }),
			)}
			{section(
				'Extra text',
				field('systemText', 'Extra text, e.g. the new chat name'),
			)}
			{section(
				'Send',
				action(
					'Send system message',
					'Shows up the way Discord writes it',
					() => run(fakeSystemNow),
				),
			)}
			{whenBlock()}
		</>
	)

	const reactionPage = (
		<>
			{pick(
				'Who reacts',
				chosen,
				personEntries(chosen, 'Tap to react as them', 'Reacting as them'),
				id => set({ senderId: id }),
			)}
			{section(
				'Reaction',
				<>
					{hint(
						'Paste the id of a message in this chat (long-press it → Copy ID).',
					)}
					{field('reactId', 'Message ID')}
					{field('reactEmoji', 'Emoji')}
				</>,
			)}
			{section(
				'Send',
				action('Add reaction', 'Adds it to that message', () =>
					run(fakeReactionNow),
				),
			)}
		</>
	)

	const diagPage = (
		<>
			{section(
				'Diagnostics',
				<>
					{info('Installed version', VERSION)}
					{info('Chat found', chat ? 'yes' : 'no')}
					{info('Chat id', chat?.id || 'none')}
					{info('Chat name', chat?.label || 'none')}
					{info(
						'Found through',
						state.diag.chat === 'selected'
							? 'the chat you have open'
							: state.diag.chat === 'last tapped'
								? 'the last chat you tapped'
								: state.diag.chat === 'typed'
									? 'the id you typed'
									: 'nothing yet',
					)}
					{info('People it can see', String(people.length))}
					{info('Chat record found', state.diag.channel ? 'yes' : 'no')}
					{info('Recipients in that record', String(state.diag.recipients))}
					{info(
						'Chat bar button module',
						state.actionButton
							? 'found (' + (state.diag.button || '?') + ')'
							: 'not found',
					)}
					{info('Plugin API keys', state.apiKeys || 'none')}
					{info('Discord API keys', state.discordKeys || 'none')}
					{info(
						'Import map',
						String(importedPaths().length) + ' paths recorded',
					)}
					{info('Chat input path', state.diag.inputPath || 'not resolved yet')}
					{info(
						'Chat bar button path',
						state.diag.buttonPath || 'not resolved yet',
					)}
					{info(
						'Module finders',
						finders()
							? 'ready (' + Object.keys(finders() ?? {}).length + ' exports)'
							: 'missing',
					)}
					{probePaths().map(probe =>
						info(
							probe.path.split('/').slice(-1)[0],
							probe.found ? 'resolves' : 'not in this build',
						),
					)}
					{info(
						'Chat input module',
						state.diag.input ? 'found (' + state.diag.input + ')' : 'not found',
					)}
					{info('Chat input name', state.diag.inputName || 'none')}
					{info(
						'Chat bar button',
						state.patched
							? state.actionButton
								? 'installed (Discord button)'
								: 'installed (plain)'
							: 'not installed',
					)}
					{info('Discord dispatcher', flux() ? 'found' : 'not found')}
					{info(
						'Channel store',
						storeOf('ChannelStore') ? 'found' : 'not found',
					)}
					{info('User store', storeOf('UserStore') ? 'found' : 'not found')}
					{info(
						'Signed in as',
						mine ? mine.username || String(mine.id) : 'unknown',
					)}
				</>,
			)}
		</>
	)

	const pages: Record<Category, Element | null> = {
		message: messagePage,
		call: callPage,
		batch: batchPage,
		system: systemPage,
		reaction: reactionPage,
		diag: diagPage,
	}

	return (
		<ScrollView
			contentContainerStyle={{
				paddingHorizontal: 16,
				paddingTop: 16,
				gap: 16,
				paddingBottom: 80,
			}}
			keyboardShouldPersistTaps="handled"
		>
			<StackView {...(D.Stack ? { spacing: 24 } : { style: { gap: 24 } })}>
				{section(
					'Chat',
					<>
						{info(
							chat ? chat.label : 'No chat found yet',
							chat
								? 'Follows the chat you open · id ' + chat.id
								: 'Tap a DM or a channel in the list, then come back here',
						)}
						{SwitchRow ? (
							<SwitchRow
								label="Fake button in chat bar"
								subLabel={
									'Tap it to send your message. Now: ' +
									(on
										? state.actionButton
											? 'on'
											: 'on (not found yet)'
										: 'off')
								}
								value={on}
								onValueChange={(value: boolean) => {
									set({ button: value })
									setStatus('Reload FakeDM to apply.')
								}}
							/>
						) : (
							action(
								'Fake button in chat bar',
								on ? 'On — tap to switch off' : 'Off — tap to switch on',
								() => {
									set({ button: !on })
									setStatus('Reload FakeDM to apply.')
								},
							)
						)}
						{field('chatId', 'Channel id (only if the chat is not found)')}
						{action('Find my chat', 'Checks which chat is open', () =>
							run(findChat),
						)}
					</>,
				)}
				{status ? hint(status) : null}
				{pick(
					'What to send',
					cat,
					CATEGORIES.map(entry => ({ value: entry.key, label: entry.label })),
					key => {
						state.cat = key as Category
						bump(n => n + 1)
					},
				)}
				{pages[cat] ?? messagePage}
				{section(
					'Clean up',
					action('Clear fakes', 'Removes every fake in this chat', () =>
						run(clearNow),
					),
				)}
			</StackView>
		</ScrollView>
	)
}

function SettingsComponent(props: { api?: PluginApiLike } = {}) {
	try {
		return <Panel {...props} />
	} catch {
		return (
			<Text style={{ padding: 16 }}>FakeDM could not draw its settings.</Text>
		)
	}
}

function FakeScreen(props: { api?: PluginApiLike }) {
	try {
		return <SettingsComponent {...props} />
	} catch {
		return (
			<Text style={{ padding: 16 }}>FakeDM could not draw its settings.</Text>
		)
	}
}

function installSettingsEntry(
	cleanup: (fn: () => void) => void,
	logger?: Logger,
) {
	const settings = SettingsModules as unknown as {
		onSettingsModulesLoaded?: (callback: () => void) => (() => void) | void
		registerSettingsSection?: (
			id: string,
			options: Record<string, unknown>,
		) => () => void
		registerSettingsItem?: (
			id: string,
			options: Record<string, unknown>,
		) => () => void
	}
	const onLoaded = settings?.onSettingsModulesLoaded
	const section = settings?.registerSettingsSection
	const item = settings?.registerSettingsItem
	if (
		typeof onLoaded !== 'function' ||
		typeof section !== 'function' ||
		typeof item !== 'function'
	) {
		logger?.warn?.('[FakeDM] this build has no settings API.')
		return
	}
	try {
		const off = onLoaded(() => {
			try {
				cleanup(
					section('FAKEDM', { label: 'FakeDM', settings: ['FAKEDM_MAIN'] }),
				)
				cleanup(
					item('FAKEDM_MAIN', {
						type: 'route',
						title: () => 'FakeDM',
						IconComponent: FakeIcon,
						screen: { route: 'FakeDMScreen', getComponent: () => FakeScreen },
					}),
				)
			} catch (error) {
				logger?.error?.('[FakeDM] could not register its settings entry', error)
			}
		})
		if (typeof off === 'function') cleanup(off)
	} catch (error) {
		logger?.error?.('[FakeDM] settings registration failed', error)
	}
}

export default {
	jsonStorage: { load: true, default: DEFAULTS },
	// Nothing in here may throw: an exception escaping start is what turns a
	// plugin bug into a client crash, so each step is sealed on its own.
	start(api: PluginApiLike) {
		state.button = null
		state.buttonKind = ''
		state.watchingInput = false
		state.watchingByNameInput = false
		// Stop removes the patch, so a restart has to install it again.
		state.patched = false
		try {
			state.finders = pickFinders(api)
			state.apiKeys = Object.keys(api ?? {}).join(', ')
			const globalDiscord = isRecord(globalThis)
				? asRecord((globalThis as Record<string, unknown>).valenced).discord
				: undefined
			state.discordKeys = Object.keys(
				api?.discord ?? (isRecord(globalDiscord) ? globalDiscord : {}),
			).join(', ')
		} catch {}
		try {
			state.storage = api?.jsonStorage ?? null
			const cached: Partial<typeof DEFAULTS> = api?.jsonStorage?.cache ?? {}
			state.cfg = { ...DEFAULTS, ...cached }
			if (!Array.isArray(state.cfg.fakes)) state.cfg.fakes = []
			// Installs that never made a choice kept the button off, which is
			// why the plugin looked like it did nothing. Turn it on once, then
			// respect whatever the user chooses from here on.
			if (cached?.barDefault !== 1 && cached?.button === undefined) {
				state.cfg = { ...state.cfg, button: true, barDefault: 1 }
				void api?.jsonStorage
					?.set?.({ button: true, barDefault: 1 })
					?.catch?.(() => {})
			}
		} catch {}
		// Follow the chat the user taps: selecting a DM in the list is what
		// makes the panel work on it, with nothing to press.
		try {
			const dispatcher = flux()
			if (typeof dispatcher?.subscribe === 'function') {
				const off = dispatcher.subscribe('CHANNEL_SELECT', event => {
					const id = event?.channelId ?? event?.channel_id
					if (id) state.lastChannelId = String(id)
				})
				if (typeof off === 'function') api?.cleanup?.(off)
			}
		} catch (error) {
			api?.logger?.warn?.('[FakeDM] could not watch chat selection', error)
		}
		const cleanup = api.cleanup
		if (!cleanup) {
			api.logger?.warn?.(
				'[FakeDM] this build hands no cleanup function; the button is left alone.',
			)
			return
		}
		try {
			patchChatInput(cleanup, api.logger)
		} catch (error) {
			api.logger?.error?.('[FakeDM] chat bar button skipped', error)
		}
		if (state.cfg.section === true) {
			try {
				installSettingsEntry(cleanup, api.logger)
			} catch (error) {
				api?.logger?.error?.('[FakeDM] settings entry skipped', error)
			}
		}
	},
	SettingsComponent,
	__engine: {
		fakeMessage,
		fakeCall,
		fakeSystem,
		fakeReaction,
		clear,
		openChat,
		addButton,
		fakeBatch,
		parseBatch,
		sender,
		resolvePerson,
	},
}
