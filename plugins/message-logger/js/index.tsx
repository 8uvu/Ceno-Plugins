// Message Logger, by cenotaph. Keeps the edits and deletions this device saw, so
// a message that changed or vanished is still readable afterwards.
//
// It is a local journal, not a second copy of the chat: only messages that
// arrived while the plugin was running are remembered, and nothing is sent
// anywhere. The page lists what changed, newest first, with the text before and
// after.
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { plural } from '../../_shared/lib/format'
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
import type { Logger } from '../../_shared/types'

type Kind = 'deleted' | 'edited'

interface Entry {
	kind: Kind
	id: string
	channelId: string
	channelName: string
	authorName: string
	before: string
	after: string
	at: number
}

interface Settings {
	enabled: boolean
	keep: number
	log: Entry[]
}

const DEFAULTS: Settings = {
	enabled: true,
	keep: 200,
	log: [],
}

// How many messages are held in memory to compare against. Enough for a busy
// channel without keeping the whole chat.
const SEEN_LIMIT = 500
// Previews are clipped so one long message cannot fill the page.
const PREVIEW = 140

interface Seen {
	content: string
	authorName: string
	channelId: string
	channelName: string
}

let logger: Logger | undefined
const seen = new Map<string, Seen>()

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

function clip(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim()
	if (!clean) return '(no text)'
	return clean.length > PREVIEW ? clean.slice(0, PREVIEW - 1) + '…' : clean
}

function keepLimit(value: unknown): number {
	const number = Number(value)
	if (!Number.isFinite(number)) return DEFAULTS.keep
	return Math.max(20, Math.min(1000, Math.round(number)))
}

function authorOf(message: Record<string, unknown>): string {
	const author = asRecord(message.author)
	const id = author.id == null ? '' : String(author.id)
	const name = author.globalName ?? author.global_name ?? author.username
	if (typeof name === 'string' && name) return name
	return id ? userName(id) : ''
}

function remember(id: string, entry: Seen): void {
	seen.delete(id)
	seen.set(id, entry)
	// Oldest first, so the map drops what has been around longest.
	while (seen.size > SEEN_LIMIT) {
		const oldest = seen.keys().next()
		if (oldest.done) break
		seen.delete(oldest.value)
	}
}

function append(
	settings: Settings,
	entry: Entry,
): Partial<Settings> {
	const log = [entry, ...(Array.isArray(settings.log) ? settings.log : [])].slice(
		0,
		keepLimit(settings.keep),
	)
	return { log }
}

function ago(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000))
	if (seconds < 60) return seconds + 's ago'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return minutes + 'm ago'
	const hours = Math.round(minutes / 60)
	if (hours < 24) return hours + 'h ago'
	return Math.round(hours / 24) + 'd ago'
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		seen.clear()

		cleanup(
			onFluxEventDispatched('MESSAGE_CREATE', (payload: unknown) => {
				try {
					const settings = (jsonStorage.cache ?? DEFAULTS) as Settings
					if (settings.enabled === false) return payload
					const message = asRecord(asRecord(payload).message)
					const id = message.id == null ? '' : String(message.id)
					if (!id) return payload
					const channelId = message.channel_id == null ? '' : String(message.channel_id)
					remember(id, {
						content: typeof message.content === 'string' ? message.content : '',
						authorName: authorOf(message),
						channelId,
						channelName: channelId ? channelName(channelId) : '',
					})
				} catch (error) {
					logger?.warn?.('[Message Logger] could not remember a message', error)
				}
				return payload
			}),
		)

		cleanup(
			onFluxEventDispatched('MESSAGE_UPDATE', (payload: unknown) => {
				try {
					const settings = (jsonStorage.cache ?? DEFAULTS) as Settings
					if (settings.enabled === false) return payload
					const message = asRecord(asRecord(payload).message)
					const id = message.id == null ? '' : String(message.id)
					if (!id) return payload
					const after =
						typeof message.content === 'string' ? message.content : ''
					const before = seen.get(id)
					// A message that arrived before the plugin started has no
					// earlier text to compare with, so it is only remembered.
					if (!before) {
						const channelId =
							message.channel_id == null ? '' : String(message.channel_id)
						remember(id, {
							content: after,
							authorName: authorOf(message),
							channelId,
							channelName: channelId ? channelName(channelId) : '',
						})
						return payload
					}
					if (before.content === after) return payload
					const entry: Entry = {
						kind: 'edited',
						id,
						channelId: before.channelId,
						channelName: before.channelName,
						authorName: before.authorName || authorOf(message),
						before: before.content,
						after,
						at: Date.now(),
					}
					before.content = after
					Promise.resolve(jsonStorage.set(append(settings, entry))).catch?.(
						() => {},
					)
				} catch (error) {
					logger?.warn?.('[Message Logger] could not log an edit', error)
				}
				return payload
			}),
		)

		cleanup(
			onFluxEventDispatched('MESSAGE_DELETE', (payload: unknown) => {
				try {
					const settings = (jsonStorage.cache ?? DEFAULTS) as Settings
					if (settings.enabled === false) return payload
					const record = asRecord(payload)
					const id = record.id == null ? '' : String(record.id)
					if (!id) return payload
					const before = seen.get(id)
					if (!before) return payload
					seen.delete(id)
					const channelId = record.channelId == null ? '' : String(record.channelId)
					const entry: Entry = {
						kind: 'deleted',
						id,
						channelId: before.channelId || channelId,
						channelName:
							before.channelName || (channelId ? channelName(channelId) : ''),
						authorName: before.authorName,
						before: before.content,
						after: '',
						at: Date.now(),
					}
					Promise.resolve(jsonStorage.set(append(settings, entry))).catch?.(
						() => {},
					)
				} catch (error) {
					logger?.warn?.('[Message Logger] could not log a deletion', error)
				}
				return payload
			}),
		)

		logger?.log?.('[Message Logger] started')
	},
	stop() {
		seen.clear()
	},
	// The storage type is declared structurally: the framework hands over its own
	// JsonStorage, whose cache is looser than these settings.
	SettingsComponent({
		api,
	}: {
		api: {
			jsonStorage: {
				use(): unknown
				set(patch: Partial<Settings>): Promise<unknown>
			}
		}
	}) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const log = Array.isArray(settings.log) ? settings.log : []
		const recent = log.slice(0, 20)
		const now = Date.now()
		const on = settings.enabled !== false

		const describe = (entry: Entry): string =>
			entry.kind === 'deleted'
				? `Deleted: “${clip(entry.before)}” · ${ago(entry.at, now)}`
				: `“${clip(entry.before)}” → “${clip(entry.after)}” · ${ago(entry.at, now)}`

		return (
			<Page>
				<Intro text="Message Logger keeps the edits and deletions this device saw, with the text before and after. Nothing is uploaded and no second copy of the chat is made." />
				<Hero
					title={
						log.length === 0
							? 'Nothing logged yet'
							: `${log.length} ${plural(log.length, 'entry', 'entries')} kept`
					}
					line="Only messages that arrived while the plugin was running."
					tone={log.length ? 'brand' : 'muted'}
				/>
				<Section
					title="Log"
					description="Off stops recording; the entries already kept stay."
				>
					<SwitchRow
						label="Keep a log"
						subLabel="Edits and deletions are compared against what was already seen."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<Row
						label={`Clear the log (${log.length})`}
						subLabel="Removes every entry from this device."
						onPress={() => set({ log: [] })}
					/>
				</Section>
				<Section
					title={log.length === 0 ? 'Nothing logged yet' : `Recent (${log.length})`}
					description={recent.length ? 'Newest first, 20 at a time.' : undefined}
				>
					{recent.length === 0 ? (
						<Row label="Nothing logged yet." subLabel="Edits and deletions show up here." />
					) : (
						recent.map((entry, index) => (
							<Row
								key={entry.id + ':' + entry.at + ':' + index}
								label={`${entry.authorName || 'Someone'} · ${entry.channelName || entry.channelId}`}
								subLabel={describe(entry)}
							/>
						))
					)}
				</Section>
				<Section title="What it can see">
					<Row
						label="Only what it watched"
						subLabel="A message sent before the plugin started has no earlier text to keep, so it is not logged."
					/>
					<Note text="The last 500 messages are held in memory only to notice a change; the log itself stays on this device." />
				</Section>
			</Page>
		)
	},
})

import { asRecord } from '../../_shared/types'