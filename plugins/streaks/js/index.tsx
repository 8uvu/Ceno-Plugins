// Streaks, by cenotaph. Counts how many days in a row you have talked to
// someone, entirely on this device: no account, no server, no token. A day
// counts as soon as any message went out or came in, so texting someone starts
// the streak, and the count is drawn next to their name in the chat.
import * as ImportTracker from '@valenced/discord/common/import-tracker'
import { Design } from '@valenced/discord/design'
import { getStore, onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import * as PathFinders from '@valenced/discord/utils/modules/finders'
import { after } from '@valenced/patcher'
import { isValidElement } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord } from '../../_shared/types'
import type {
	DesignShim,
	DiscordChannel,
	JsonStorage,
	Logger,
	MessageCreatePayload,
	ModuleWithType,
	StoreLike,
} from '../../_shared/types'

interface Day {
	in: number
	out: number
}

interface Conversation {
	name: string
	days: Record<string, Day>
	longest: number
}

interface Settings {
	enabled: boolean
	// A day counts once each side has written. Off by default: one message is
	// enough for the day, so the streak actually starts when you text someone.
	bothSides: boolean
	// Draws the streak next to the other person's name in the chat.
	badge: boolean
	conversations: Record<string, Conversation>
}

const DEFAULTS: Settings = {
	enabled: true,
	bothSides: false,
	badge: true,
	conversations: {},
}
// Enough history for a year-long streak without the storage file growing
// forever.
const KEEP_DAYS = 400
const DM = 1
const GROUP_DM = 3
const BADGE_KEY = 'streaks-badge'

// Where the name of the chat is drawn. Discord renames these files between
// releases, so the import map is searched first and these are the fallbacks.
const HEADER_CANDIDATES = [
	'modules/channels/native/ChannelHeader.tsx',
	'modules/channels/native/ChannelTitle.tsx',
	'modules/channels/native/DMChannelHeader.tsx',
	'modules/channels/native/direct_messages/ChannelHeader.tsx',
	'modules/channels/native/header/ChannelHeader.tsx',
	'modules/messages/native/ChannelHeader.tsx',
]

export function dayKey(at: number): string {
	const date = new Date(at)
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return date.getFullYear() + '-' + month + '-' + day
}

// Local-date arithmetic, so a streak survives time zones and DST: the key is
// parsed back into a local date before it is shifted.
export function shiftDay(key: string, delta: number): string {
	const [year, month, day] = key.split('-').map(Number)
	const date = new Date(year, (month ?? 1) - 1, day ?? 1)
	date.setDate(date.getDate() + delta)
	return dayKey(date.getTime())
}

function dayOf(conversation: Conversation, key: string): Day {
	return conversation.days[key] ?? { in: 0, out: 0 }
}

function active(day: Day, bothSides: boolean): boolean {
	return bothSides ? day.in > 0 && day.out > 0 : day.in + day.out > 0
}

// A streak may still be alive today when nothing has been said yet, so an
// inactive today starts counting from yesterday.
export function currentStreak(
	conversation: Conversation,
	today: string,
	bothSides: boolean,
): number {
	let cursor = active(dayOf(conversation, today), bothSides)
		? today
		: shiftDay(today, -1)
	let streak = 0
	while (active(dayOf(conversation, cursor), bothSides)) {
		streak++
		cursor = shiftDay(cursor, -1)
		// Four years of days is more than any real streak; stops a corrupt day
		// map from looping forever.
		if (streak > 1500) break
	}
	return streak
}

function prune(days: Record<string, Day>): Record<string, Day> {
	const keys = Object.keys(days).sort().reverse().slice(0, KEEP_DAYS)
	const out: Record<string, Day> = {}
	for (const key of keys) out[key] = days[key] as Day
	return out
}

export function record(
	current: Settings,
	channelId: string,
	name: string,
	fromMe: boolean,
	at: number,
): Partial<Settings> {
	const conversations = current.conversations ?? {}
	const existing = conversations[channelId]
	const conversation: Conversation = existing ?? {
		name,
		days: {},
		longest: 0,
	}
	const key = dayKey(at)
	const day = dayOf(conversation, key)
	const nextDay: Day = fromMe
		? { in: day.in, out: day.out + 1 }
		: { in: day.in + 1, out: day.out }
	const days = prune({ ...conversation.days, [key]: nextDay })
	const streak = currentStreak(
		{ ...conversation, days },
		key,
		current.bothSides === true,
	)
	return {
		conversations: {
			...conversations,
			[channelId]: {
				name: name || conversation.name || 'Conversation',
				days,
				longest: Math.max(conversation.longest ?? 0, streak),
			},
		},
	}
}

export interface Ranked {
	id: string
	name: string
	streak: number
	longest: number
	today: Day
}

export function ranked(
	current: Settings,
	today: string,
): Ranked[] {
	const bothSides = current.bothSides === true
	return Object.entries(current.conversations ?? {})
		.map(([id, conversation]) => ({
			id,
			name: conversation.name || 'Conversation',
			streak: currentStreak(conversation, today, bothSides),
			longest: conversation.longest ?? 0,
			today: dayOf(conversation, today),
		}))
		.sort((a, b) => b.streak - a.streak || b.longest - a.longest)
}

function store(name: string): StoreLike | null {
	try {
		const proxied = (Stores as Record<string, unknown> | undefined)?.[name]
		if (proxied) return proxied as StoreLike
	} catch {}
	try {
		const lookup = getStore as unknown as (key: string) => unknown
		const direct = lookup?.(name)
		if (direct) return direct as StoreLike
	} catch {}
	return null
}

function selfId(): string {
	try {
		return String(store('UserStore')?.getCurrentUser?.()?.id ?? '')
	} catch {
		return ''
	}
}

function channelFor(id: string): DiscordChannel | null {
	try {
		return store('ChannelStore')?.getChannel?.(id) ?? null
	} catch {
		return null
	}
}

function isDm(channel: DiscordChannel | null): boolean {
	// An unknown channel is kept: losing a real conversation is worse than
	// counting a guild channel whose store entry is missing.
	if (!channel) return true
	return channel.type === DM || channel.type === GROUP_DM || !channel.guild_id
}

function nameOf(channel: DiscordChannel | null, id: string): string {
	const recipient = channel?.recipients?.[0]
	if (recipient && typeof recipient === 'object') {
		const user = recipient
		const name = user.globalName || user.username
		if (name) return name
	}
	return channel?.name || 'DM ' + id.slice(-4)
}

function describe(entry: Ranked): string {
	const days = entry.streak === 1 ? '1 day' : entry.streak + ' days'
	const today =
		entry.today.in + entry.today.out === 0
			? 'nothing today yet'
			: 'today ' + entry.today.out + ' sent, ' + entry.today.in + ' received'
	return days + ' — ' + today + ' · best ' + entry.longest
}

// ─── The badge next to the name ──────────────────────────────────────────────
// Discord has no way to decorate a name, so the chat header component is
// patched and the count is inserted into its children. Every lookup and every
// render is wrapped: a build that moved the component must lose the badge, not
// the chat screen.
let live: JsonStorage<Settings> | null = null
const patched = new Set<unknown>()

interface ModuleFinders {
	getModuleWithImportedPath?(
		path: string,
		callback: (mod: ModuleWithType) => void,
	): () => void
	lookupModuleWithImportedPath?(path: string): ModuleWithType[]
}

function currentSettings(): Settings {
	try {
		return live?.cache ?? DEFAULTS
	} catch {
		return DEFAULTS
	}
}

function streakFor(channelId: string): number {
	if (!channelId) return 0
	const settings = currentSettings()
	if (settings.enabled === false) return 0
	const conversation = settings.conversations?.[channelId]
	if (!conversation) return 0
	return currentStreak(
		conversation,
		dayKey(Date.now()),
		settings.bothSides === true,
	)
}

// The header keeps its chat in a different prop on each build.
function channelIdIn(props: Record<string, unknown>): string {
	for (const key of ['channelId', 'channel_id']) {
		const value = props[key]
		if (value) return String(value)
	}
	const channel = asRecord(props.channel)
	if (channel.id) return String(channel.id)
	return ''
}

function badge(streak: number) {
	return (
		<Text
			key={BADGE_KEY}
			style={{
				color: token('TEXT_MUTED'),
				fontSize: 12,
				fontWeight: '600',
				marginLeft: 6,
			}}
		>
			{'🔥 ' + streak}
		</Text>
	)
}

function withBadge(node: unknown, streak: number): unknown {
	if (streak <= 0 || !isValidElement(node)) return node
	const props = asRecord((node as { props?: unknown }).props)
	const children = props.children
	const list: unknown[] =
		Array.isArray(children)
			? [...children]
			: children === undefined || children === null
				? []
				: [children]
		if (list.some(child => asRecord(child).key === BADGE_KEY)) return node
	list.push(badge(streak))
	return { ...(node as object), props: { ...props, children: list } }
}

function finders(): ModuleFinders | null {
	try {
		const candidate = PathFinders as unknown as ModuleFinders
		if (typeof candidate?.lookupModuleWithImportedPath === 'function')
			return candidate
		if (typeof candidate?.getModuleWithImportedPath === 'function')
			return candidate
	} catch {}
	return null
}

// Every path the running client has recorded that looks like the bar holding
// the name. Discord records this map lazily, so it grows as screens open.
function headerPaths(): string[] {
	const paths: string[] = []
	try {
		const source = (ImportTracker as unknown as { mImportedPaths?: unknown })
			.mImportedPaths
		if (!(source instanceof Map)) return paths
		source.forEach((value: unknown) => {
			if (typeof value !== 'string') return
			if (!/\.tsx?$/.test(value)) return
			if (!/(header|title)/i.test(value)) return
			if (
				/(chat_input|settings|search|emoji|sticker|gift|attach|gallery|toast|modal|call)/i.test(
					value,
				)
			)
				return
			paths.push(value)
		})
	} catch {}
	return paths
}

// Module finders hand back either the module or an ES module namespace whose
// `default` is the module; both spellings show up depending on the build.
function componentOf(mod: ModuleWithType | null): ModuleWithType | null {
	if (!mod) return null
	if (typeof mod.type === 'function') return mod
	const inner = asRecord(mod.default)
	return typeof inner?.type === 'function' ? (inner as ModuleWithType) : null
}

function patchHeader(
	mod: ModuleWithType | null,
	cleanup: (fn: () => void) => void,
	logger?: Logger,
): boolean {
	const component = componentOf(mod)
	if (!component || typeof component.type !== 'function') return false
	if (patched.has(component.type)) return true
	try {
		// The hook is handed (args, result) on current builds; older ones pass the
		// rendered element first. Whatever goes wrong, Discord's own element is
		// returned: a throw here would take the chat screen down.
		const off = after(component, 'type', (...params: unknown[]) => {
			let result: unknown = params[1] ?? params[0]
			try {
				const rendered = params.find(value => isValidElement(value))
				if (rendered) result = rendered
				if (currentSettings().badge === false) return result
				const id = channelIdIn(asRecord(asRecord(result).props))
				return withBadge(result, streakFor(id))
			} catch {
				return result
			}
		})
		if (typeof off === 'function') cleanup(off as () => void)
		patched.add(component.type)
		return true
	} catch (error) {
		logger?.warn?.('[Streaks] could not patch a chat header', error)
		return false
	}
}

function installBadge(
	cleanup: (fn: () => void) => void,
	logger?: Logger,
) {
	const lookup = finders()
	if (!lookup) {
		logger?.warn?.('[Streaks] no module finders; the badge stays off')
		return
	}
	const scan = (): boolean => {
		let found = false
		const seen = new Set<string>()
		for (const path of [...headerPaths(), ...HEADER_CANDIDATES]) {
			if (seen.has(path)) continue
			seen.add(path)
			let mod: ModuleWithType | null = null
			try {
				mod = (lookup.lookupModuleWithImportedPath?.(path) ?? [])[0] ?? null
			} catch {
				mod = null
			}
			if (mod && patchHeader(mod, cleanup, logger)) found = true
		}
		return found
	}
	if (scan()) {
		logger?.log?.('[Streaks] badge installed on the chat header')
		return
	}
	// The header module only exists once a chat has been opened, so the lookup is
	// retried briefly instead of once at start.
	let tries = 0
	const timer = setInterval(() => {
		if (scan()) {
			clearInterval(timer)
			logger?.log?.('[Streaks] badge installed on the chat header')
			return
		}
		if (++tries > 40) {
			clearInterval(timer)
			logger?.warn?.('[Streaks] no chat header found; the badge stays off')
		}
	}, 1500)
	cleanup(() => clearInterval(timer))
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		live = jsonStorage
		cleanup(
			// A listener only: the payload goes back untouched.
			onFluxEventDispatched(
				'MESSAGE_CREATE',
				(payload: MessageCreatePayload | null) => {
					try {
						const current = jsonStorage.cache ?? DEFAULTS
						if (current.enabled === false || !payload) return payload
						const message = payload.message
						const channelId = message?.channel_id ?? payload.channelId
						const author = message?.author?.id
						if (!channelId || !author) return payload
						const channel = channelFor(String(channelId))
						if (!isDm(channel)) return payload
						const me = selfId()
						Promise.resolve(
							jsonStorage.set(
								record(
									current,
									String(channelId),
									nameOf(channel, String(channelId)),
									Boolean(me) && String(author) === me,
									Date.now(),
								),
							),
						).catch?.(() => {})
					} catch (error) {
						logger?.warn?.('[Streaks] skipped a message', error)
					}
					return payload
				},
			),
		)
		try {
			patched.clear()
			installBadge(cleanup, logger)
		} catch (error) {
			logger?.warn?.('[Streaks] the chat badge is unavailable', error)
		}
		logger?.log?.('[Streaks] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings = api.jsonStorage.use() ?? DEFAULTS
		const set = (patch: Partial<Settings>) =>
			api.jsonStorage.set(patch).catch?.(() => {})
		const today = dayKey(Date.now())
		const list = ranked(settings, today)
		const best = list[0]?.streak ?? 0
		const D = (Design ?? {}) as unknown as DesignShim
		const muted = token('TEXT_MUTED')
		const normal = token('TEXT_NORMAL')

		const row = (key: string, label: string, subLabel?: string) =>
			D.TableRow ? (
				<D.TableRow key={key} label={label} subLabel={subLabel} />
			) : (
				<View key={key} style={{ paddingVertical: 6 }}>
					<Text style={{ color: normal }}>{label}</Text>
					{subLabel ? <Text style={{ color: muted }}>{subLabel}</Text> : null}
				</View>
			)

		if (D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<D.TableRowGroup title="Streaks">
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Track streaks"
								subLabel="Counts the days you and someone talked. Stored on this device only."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Show the streak in chat"
								subLabel="Draws the count next to the other person's name."
								value={settings.badge !== false}
								onValueChange={(v: boolean) => set({ badge: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Both sides count"
								subLabel="A day counts once each of you sent something. Off counts any message."
								value={settings.bothSides === true}
								onValueChange={(v: boolean) => set({ bothSides: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="Reset all streaks"
								subLabel="Deletes every conversation this plugin has recorded."
								onPress={() => set({ conversations: {} })}
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup
						title={
							best > 0
								? 'Best right now: ' + best + (best === 1 ? ' day' : ' days')
								: 'No streak running'
						}
					>
						{list.length === 0
							? row('empty', 'Nothing recorded yet.', 'Send a message in a DM to start.')
							: list.map(entry =>
									row(entry.id, entry.name, describe(entry)),
								)}
					</D.TableRowGroup>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: normal, fontWeight: 'bold', marginBottom: 8 }}>
					Streaks
				</Text>
				<Pressable
					accessibilityLabel="Track streaks"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Track streaks: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Show the streak in chat"
					onPress={() => set({ badge: !(settings.badge !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Show the streak in chat: {settings.badge !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Reset all streaks"
					onPress={() => set({ conversations: {} })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>Reset all streaks</Text>
				</Pressable>
				<Text style={{ color: normal, marginTop: 8 }}>
					{best > 0 ? 'Best right now: ' + best : 'No streak running'}
				</Text>
				{list.length === 0 ? (
					<Text style={{ color: muted, marginTop: 8 }}>
						Nothing recorded yet. Send a message in a DM to start.
					</Text>
				) : (
					list.map(entry => (
						<Text key={entry.id} style={{ color: normal, marginTop: 6 }}>
							{entry.name} — {describe(entry)}
						</Text>
					))
				)}
			</ScrollView>
		)
	},
})
