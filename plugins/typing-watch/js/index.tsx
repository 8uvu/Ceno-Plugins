// TypingWatch, by cenotaph. Keeps the last few typing indicators you missed.
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { plural } from '../../_shared/lib/format'
import {
	Hero,
	Intro,
	Page,
	Row,
	Section,
	SwitchRow,
} from '../../_shared/lib/kit'
import { useSettings } from '../../_shared/lib/settings'
import type { JsonStorage } from '../../_shared/types'

type TypingPayload = { channelId?: string | number; userId?: string | number }

interface Entry {
	channelId: string
	userId: string
	at: number
}

interface Settings {
	enabled: boolean
	recent: Entry[]
}

const DEFAULTS: Settings = { enabled: true, recent: [] }
const KEEP = 20

export function ago(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000))
	if (seconds < 60) return seconds + 's ago'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return minutes + 'm ago'
	const hours = Math.round(minutes / 60)
	if (hours < 24) return hours + 'h ago'
	return Math.round(hours / 24) + 'd ago'
}

// Newest first, one row per person and channel: the same person typing again in
// the same channel moves their row up rather than filling the list.
export function remember(recent: Entry[], entry: Entry): Entry[] {
	const rest = (Array.isArray(recent) ? recent : []).filter(
		item =>
			!(item?.channelId === entry.channelId && item?.userId === entry.userId),
	)
	return [entry, ...rest].slice(0, KEEP)
}

// The list reads as names, not snowflakes: the stores are asked at draw time and
// an id stays the fallback, so a missing store never blanks a row.
function storeNamed(name: string): Record<string, unknown> | null {
	try {
		const found = (Stores as unknown as Record<string, unknown>)[name]
		return found && typeof found === 'object'
			? (found as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

function userName(id: string): string {
	const lookup = storeNamed('UserStore')?.getUser
	if (typeof lookup !== 'function') return id
	try {
		const user = (lookup as (id: string) => unknown)(id)
		const record =
			user && typeof user === 'object' ? (user as Record<string, unknown>) : {}
		const name = record.globalName ?? record.username
		return typeof name === 'string' && name ? name : id
	} catch {
		return id
	}
}

function channelName(id: string): string {
	const lookup = storeNamed('ChannelStore')?.getChannel
	if (typeof lookup !== 'function') return id
	try {
		const channel = (lookup as (id: string) => unknown)(id)
		const record =
			channel && typeof channel === 'object'
				? (channel as Record<string, unknown>)
				: {}
		if (typeof record.name === 'string' && record.name) return '#' + record.name
		const recipients = Array.isArray(record.recipients) ? record.recipients : []
		const other = recipients[0]
		if (other && typeof other === 'object') {
			const person = other as Record<string, unknown>
			const name = person.globalName ?? person.username
			if (typeof name === 'string' && name) return name
		}
	} catch {}
	return id
}

function labelOf(entry: Entry): string {
	return userName(entry.userId) + ' in ' + channelName(entry.channelId)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		cleanup(
			// A listener, not a gate: the payload goes back untouched so the
			// indicator still shows for everyone.
			onFluxEventDispatched('TYPING_START', (payload: TypingPayload | null) => {
				const current = jsonStorage.cache ?? DEFAULTS
				if (
					current.enabled === false ||
					!payload ||
					typeof payload !== 'object'
				)
					return payload
				const channelId =
					payload.channelId == null ? '' : String(payload.channelId)
				const userId = payload.userId == null ? '' : String(payload.userId)
				if (!channelId || !userId) return payload
				const entry: Entry = { channelId, userId, at: Date.now() }
				Promise.resolve(
					jsonStorage.set({ recent: remember(current.recent ?? [], entry) }),
				).catch?.(() => {})
				return payload
			}),
		)
		logger?.log?.('[TypingWatch] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const [settings, set] = useSettings(api.jsonStorage, DEFAULTS)
		const recent = Array.isArray(settings.recent) ? settings.recent : []
		const now = Date.now()
		const on = settings.enabled !== false
		return (
			<Page>
				<Intro text="TypingWatch keeps the last 20 typing indicators you missed, so a name that vanished before you looked is still there to read." />
				<Hero
					title={
						recent.length === 0
							? 'Nobody has typed'
							: `${recent.length} ${plural(recent.length, 'person', 'people')} remembered`
					}
					line={
						recent.length === 0
							? 'Start typing anywhere and the list fills itself.'
							: 'Newest first, one row per person and channel.'
					}
					tone={recent.length ? 'brand' : 'muted'}
				/>
				<Section title="TypingWatch">
					<SwitchRow
						label="Remember who types"
						subLabel="Keeps the last 20 people who started typing."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<Row
						label={`Clear the list (${recent.length})`}
						subLabel="Empties the list; nothing else is touched."
						onPress={() => set({ recent: [] })}
					/>
				</Section>
				<Section
					title={recent.length ? `Recent (${recent.length})` : 'Recent'}
					description={recent.length ? 'Newest first.' : undefined}
				>
					{recent.length === 0 ? (
						<Row
							label="Nobody has typed yet."
							subLabel="A typing indicator shows up here after it is seen."
						/>
					) : (
						recent.map(entry => (
							<Row
								key={entry.channelId + ':' + entry.userId}
								label={labelOf(entry)}
								subLabel={ago(entry.at, now)}
							/>
						))
					)}
				</Section>
			</Page>
		)
	},
})
