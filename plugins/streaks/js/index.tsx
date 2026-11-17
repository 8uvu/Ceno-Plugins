// Streaks, by cenotaph. Counts how many days in a row you have talked to
// someone, entirely on this device: no account, no server, no token. A day
// counts once a message went each way, so it tracks a conversation and not
// just your own activity.
import { Design } from '@valenced/discord/design'
import {
	getStore,
	onFluxEventDispatched,
	Stores,
} from '@valenced/discord/flux'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import type {
	DesignShim,
	DiscordChannel,
	JsonStorage,
	MessageCreatePayload,
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
	bothSides: boolean
	conversations: Record<string, Conversation>
}

const DEFAULTS: Settings = { enabled: true, bothSides: true, conversations: {} }
// Enough history for a year-long streak without the storage file growing
// forever.
const KEEP_DAYS = 400
const DM = 1
const GROUP_DM = 3

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
		current.bothSides !== false,
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
	const bothSides = current.bothSides !== false
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

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
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
								subLabel="Counts the days you and someone messaged each other. Stored on this device only."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Both sides count"
								subLabel="A day counts once each of you sent something. Turn off to count any message."
								value={settings.bothSides !== false}
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
