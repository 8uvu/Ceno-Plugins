// Voice Time, by cenotaph. Keeps the call history this client does not: every
// call this device saw, how long it lasted, and how long you spent in it with
// each person. Nothing is uploaded and nothing about anyone else is stored
// beyond the time they shared a call with you.

import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { ask } from '../../_shared/lib/confirm'
import { ago, channelName, selfId, span, userName } from '../../_shared/lib/format'
import {
	Hero,
	Intro,
	Note,
	Page,
	Row,
	Section,
	SwitchRow,
} from '../../_shared/lib/kit'
import { useSettings } from '../../_shared/lib/settings'
import { say } from '../../_shared/lib/toast'
import type { JsonStorage } from '../../_shared/types'

type VoiceState = {
	userId?: string
	user_id?: string
	channelId?: string
	channel_id?: string
	guildId?: string
	guild_id?: string
}

type VoiceStatePayload = VoiceState & {
	voiceState?: VoiceState
	voiceStates?: VoiceState[]
}

type Call = {
	id: string
	channelId: string
	guildId: string | null
	startedAt: number
	endedAt: number
	ms: number
}

type Person = {
	id: string
	name: string
	ms: number
	lastAt: number
}

type OpenCall = {
	channelId: string
	guildId: string | null
	startedAt: number
	// Who is in the call with me right now, and when they joined it.
	with: Record<string, number>
	// Time already banked per person this call, so someone who leaves early is
	// counted to the minute they left rather than to the end of the call.
	shared: Record<string, number>
}

interface Settings {
	enabled: boolean
	calls: Call[]
	people: Person[]
	open: OpenCall | null
}

const DEFAULTS: Settings = {
	enabled: true,
	calls: [],
	people: [],
	open: null,
}

// A menu tap that fails to join, or a call left after two seconds, is not a
// call worth keeping.
const FLOOR_MS = 10_000
const CALL_CAP = 400
const PEOPLE_CAP = 300

function idOf(value: unknown): string | null {
	return value === undefined || value === null || value === ''
		? null
		: String(value)
}

function startOfDay(now: number): number {
	const date = new Date(now)
	date.setHours(0, 0, 0, 0)
	return date.getTime()
}

// Monday, so "this week" matches what a person expects from a week.
function startOfWeek(now: number): number {
	const date = new Date(now)
	date.setHours(0, 0, 0, 0)
	date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
	return date.getTime()
}

function totalSince(calls: Call[], since: number): number {
	let total = 0
	for (const call of calls) if (call.endedAt >= since) total += call.ms
	return total
}

// Everyone already sitting in a channel when I join it, so a call that was
// already going is counted from my side, not only from the next event.
function membersIn(channelId: string): Record<string, number> {
	const found: Record<string, number> = {}
	try {
		const store = Stores.VoiceStateStore
		const raw = store?.getVoiceStatesForChannel?.(channelId)
		const list: VoiceState[] = Array.isArray(raw)
			? raw
			: raw && typeof raw === 'object'
				? Object.values(raw as Record<string, VoiceState>)
				: []
		const me = selfId()
		const now = Date.now()
		for (const state of list) {
			const userId = String(state?.userId ?? state?.user_id ?? '')
			if (userId && userId !== me) found[userId] = now
		}
	} catch {}
	return found
}

// Adds one call's worth of shared time to the people map and keeps it ordered.
function credited(
	people: Person[],
	shared: Record<string, number>,
	at: number,
): Person[] {
	const map = new Map<string, Person>()
	for (const person of people) map.set(person.id, { ...person })
	for (const [id, delta] of Object.entries(shared)) {
		if (delta <= 0) continue
		const current = map.get(id) ?? { id, name: userName(id), ms: 0, lastAt: at }
		map.set(id, {
			...current,
			name: userName(id),
			ms: current.ms + delta,
			lastAt: at,
		})
	}
	return [...map.values()]
		.sort((a, b) => b.ms - a.ms)
		.slice(0, PEOPLE_CAP)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		// The device's storage type is wider (its cache may be undefined); the
		// fields this plugin reads are exactly what Settings declares.
		const store = jsonStorage as unknown as JsonStorage<Settings>
		let open: OpenCall | null = null

		const read = (): Settings => ({ ...DEFAULTS, ...(store.cache ?? {}) })
		const save = (patch: Partial<Settings>) => {
			void store.set(patch)
		}
		const drop = () => {
			open = null
			save({ open: null })
		}

		// A call that was open when the app last closed cannot be trusted: the
		// hours after the app closed were never seen, so it is dropped rather
		// than billed to now.
		if (read().open) drop()

		const closeCall = (at: number) => {
			const current = open
			if (!current) return
			open = null
			const ms = Math.max(0, at - current.startedAt)
			if (ms < FLOOR_MS) {
				save({ open: null })
				return
			}
			const cfg = read()
			const shared: Record<string, number> = { ...(current.shared ?? {}) }
			for (const [id, joinedAt] of Object.entries(current.with))
				shared[id] = (shared[id] ?? 0) + Math.max(0, at - joinedAt)
			const id = current.channelId + ':' + current.startedAt
			const call: Call = {
				id,
				channelId: current.channelId,
				guildId: current.guildId,
				startedAt: current.startedAt,
				endedAt: at,
				ms,
			}
			save({
				calls: [call, ...cfg.calls.filter(item => item.id !== id)].slice(
					0,
					CALL_CAP,
				),
				people: credited(cfg.people, shared, at),
				open: null,
			})
			say(
				'voice-time',
				`You were in ${channelName(call.channelId)} for ${span(ms)}.`,
			)
		}

		const handle = (payload: VoiceStatePayload) => {
			try {
				const cfg = read()
				const me = selfId()
				if (!me) return payload
				const states = Array.isArray(payload?.voiceStates)
					? payload.voiceStates
					: payload?.voiceState
						? [payload.voiceState]
						: [payload]
				const now = Date.now()

				for (const state of states) {
					const userId = String(state?.userId ?? state?.user_id ?? '')
					if (!userId) continue
					const channelId = idOf(state?.channelId ?? state?.channel_id)

					if (userId === me) {
						if (!cfg.enabled) {
							if (open) drop()
							continue
						}
						if (channelId && open?.channelId === channelId) continue
						if (open) closeCall(now)
						if (!channelId) continue
						open = {
							channelId,
							guildId: idOf(
								state?.guildId ?? state?.guild_id ?? payload?.guildId,
							),
							startedAt: now,
							with: membersIn(channelId),
							shared: {},
						}
						save({ open })
						continue
					}

					// Everyone else only matters while I am in a call.
					if (!cfg.enabled || !open) continue
					const joinedAt = open.with[userId]
					if (channelId === open.channelId && !joinedAt) {
						open.with[userId] = now
						save({ open })
					} else if (channelId !== open.channelId && joinedAt) {
						// Banked at the moment they left, so a short stay is not padded
						// out to the end of the call.
						open.shared[userId] =
							(open.shared[userId] ?? 0) + Math.max(0, now - joinedAt)
						delete open.with[userId]
						save({ open })
					}
				}
			} catch (error) {
				logger?.error?.('[VoiceTime] handler failed', error)
			}
			return payload
		}

		// Discord dispatches the plural form with an array; the older shape is a
		// single `voiceState`. Listening to both means one build change cannot
		// silently stop the log.
		cleanup(onFluxEventDispatched('VOICE_STATE_UPDATE', handle))
		cleanup(onFluxEventDispatched('VOICE_STATE_UPDATES', handle))
		cleanup(() => {
			open = null
		})
		logger?.log?.('[VoiceTime] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const calls = settings.calls ?? []
		const people = settings.people ?? []
		const now = Date.now()
		const today = totalSince(calls, startOfDay(now))
		const week = totalSince(calls, startOfWeek(now))
		const all = totalSince(calls, 0)
		const recording = settings.enabled !== false
		const recent = calls.slice(0, 5)
		const closest = people.slice(0, 5)
		return (
			<Page>
				<Intro text="Voice Time keeps a log of the calls this device saw: where, when, how long, and who was in them with you. Only calls while Discord was open are counted, and nothing is uploaded." />
				<Hero
					title={today ? `${span(today)} in calls today` : 'No calls yet today'}
					line={
						recording
							? calls.length
								? `${calls.length} ${calls.length === 1 ? 'call' : 'calls'} in the log, ${span(all)} in total.`
								: 'Join a voice channel and the call appears here when you leave it.'
							: 'Recording is off — nothing new is being logged.'
					}
					tone={recording ? 'brand' : 'muted'}
				/>
				<Section title="This device">
					<SwitchRow
						label="Record my calls"
						subLabel="Off leaves the log alone and stops new calls from being written."
						value={recording}
						onChange={enabled => set({ enabled })}
					/>
				</Section>
				<Section title="Totals">
					<Row label="Today" subLabel={today ? span(today) : 'Nothing yet'} />
					<Row label="This week" subLabel={week ? span(week) : 'Nothing yet'} />
					<Row label="All time" subLabel={all ? span(all) : 'Nothing yet'} />
					<Row
						label="Calls"
						subLabel={`${calls.length} ${calls.length === 1 ? 'call' : 'calls'} in the log`}
					/>
				</Section>
				<Section
					title="Most time with"
					description="Counted from shared time in the call, not from guesses."
				>
					{closest.length ? (
						closest.map(person => (
							<Row
								key={person.id}
								label={person.name}
								subLabel={span(person.ms)}
							/>
						))
					) : (
						<Row label="Nobody yet" subLabel="Be in a call with someone to start counting." />
					)}
				</Section>
				<Section title="Recent calls">
					{recent.length ? (
						recent.map(call => (
							<Row
								key={call.id}
								label={channelName(call.channelId)}
								subLabel={`${span(call.ms)} · ${ago(call.endedAt, now)}`}
							/>
						))
					) : (
						<Row label="No calls yet" subLabel="The log starts with the next call." />
					)}
				</Section>
				<Section title="Careful">
					<Row
						label="Forget every call"
						subLabel="Clears the log and the per-person totals on this device."
						danger
						onPress={() =>
							ask({
								title: 'Forget every call?',
								body: 'The log and the time with each person are cleared. This cannot be undone.',
								confirm: 'Forget',
								danger: true,
								onConfirm: () => set({ calls: [], people: [], open: null }),
							})
						}
					/>
				</Section>
				<Note text="Only calls while Discord was open with this plugin started are counted. A call that was still running when the app closed is dropped rather than billed to the time you come back." />
			</Page>
		)
	},
})
