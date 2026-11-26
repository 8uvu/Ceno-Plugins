// Watchlist, by cenotaph. A tap on the shoulder when someone you are watching
// comes online, starts typing to you, or sends you a message.
//
// Everything is local: the list of people lives in this plugin's own storage,
// the events are the ones the client already dispatches, and a notification is a
// toast. No account, no server, no token.
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { addMessageMenuRows } from '../../_shared/actionSheet'
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
import type {
	DesignComponent,
	JsonStorage,
	Logger,
} from '../../_shared/types'

interface Person {
	id: string
	name: string
	// When the person was added, so the page can say how long they have been on
	// the list.
	since: number
}

interface Settings {
	enabled: boolean
	presence: boolean
	typing: boolean
	messages: boolean
	people: Record<string, Person>
}

const DEFAULTS: Settings = {
	enabled: true,
	presence: true,
	typing: true,
	messages: true,
	people: {},
}

// One toast per person per kind of event, so a busy conversation does not turn
// into a wall of toasts.
const TYPING_GAP_MS = 15000
const MESSAGE_GAP_MS = 5000
const PRESENCE_GAP_MS = 60000

interface MessageLike {
	id?: string
	author?: {
		id?: string
		username?: string
		globalName?: string
		global_name?: string
	}
}

interface RowComponent {
	(props: Record<string, unknown>): unknown
	Group?: DesignComponent
	Icon?: DesignComponent
}

let logger: Logger | undefined
// The framework's storage type is looser than this plugin's settings, so only
// what is used is declared here and the cache is cast on read.
let live: {
	cache?: unknown
	set(patch: Partial<Settings>): Promise<unknown>
} | null = null
const statuses = new Map<string, string>()
const lastToast = new Map<string, number>()

function current(): Settings {
	try {
		return ((live?.cache as Settings | undefined) ?? DEFAULTS) as Settings
	} catch {
		return DEFAULTS
	}
}

function write(patch: Partial<Settings>): void {
	try {
		Promise.resolve(live?.set(patch)).catch?.(() => {})
	} catch {}
}

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

function selfId(): string {
	try {
		const store = storeNamed('UserStore')
		const get = store?.getCurrentUser
		if (typeof get !== 'function') return ''
		const me = (get as () => unknown)()
		const record = me && typeof me === 'object' ? (me as Record<string, unknown>) : {}
		return typeof record.id === 'string' ? record.id : ''
	} catch {
		return ''
	}
}

function displayName(author?: MessageLike['author']): string {
	if (!author) return ''
	const name = author.globalName ?? author.global_name ?? author.username
	return typeof name === 'string' && name ? name : (author.id ?? '')
}

function nameOf(id: string): string {
	const person = current().people?.[id]
	return person?.name || userName(id)
}

function toast(text: string): void {
	try {
		ToastActionCreators.open('watchlist', { text })
		return
	} catch {}
	try {
		ToastActionCreators.open({ key: 'watchlist', content: text })
	} catch {}
}

// True when this person has not been announced for this kind of event recently.
function allowed(key: string, gapMs: number): boolean {
	const now = Date.now()
	const last = lastToast.get(key) ?? 0
	if (now - last < gapMs) return false
	lastToast.set(key, now)
	return true
}

function watch(id: string, name: string): void {
	if (!id) return
	const settings = current()
	if (settings.people?.[id]) return
	write({
		people: {
			...(settings.people ?? {}),
			[id]: { id, name: name || userName(id), since: Date.now() },
		},
	})
	toast(`Now watching ${name || userName(id)}.`)
}

function unwatch(id: string): void {
	const settings = current()
	if (!settings.people?.[id]) return
	const people = { ...(settings.people ?? {}) }
	const name = people[id]?.name || userName(id)
	delete people[id]
	write({ people })
	toast(`Stopped watching ${name}.`)
}

function iconFor(name: string): unknown {
	try {
		return lookupGeneratedIconComponent(name)
	} catch {
		return undefined
	}
}

// The row this plugin adds to the message menu: watch or stop watching the
// author of the message that was held.
function menuRows(message: MessageLike): unknown[] {
	const design = asRecord(Design)
	const Row = design.ActionSheetRow as RowComponent | undefined
	if (typeof Row !== 'function') return []
	const author = message.author
	const id = typeof author?.id === 'string' ? author.id : ''
	if (!id || id === selfId()) return []
	const Group = Row.Group
	const Icon = Row.Icon
	const watching = Boolean(current().people?.[id])
	const name = displayName(author) || userName(id)
	const icon = (iconName: string): unknown => {
		if (typeof Icon !== 'function') return undefined
		const component = iconFor(iconName)
		return component ? <Icon IconComponent={component} /> : undefined
	}
	const row = (
		<Row
			key="watchlist-toggle"
			label={watching ? `Stop watching ${name}` : `Watch ${name}`}
			icon={icon(watching ? 'BellSlashIcon' : 'BellIcon')}
			onPress={() => {
				if (watching) unwatch(id)
				else watch(id, name)
			}}
		/>
	)
	if (typeof Group === 'function')
		return [<Group key="watchlist">{row}</Group>]
	return [row]
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		statuses.clear()
		lastToast.clear()

		cleanup(
			onFluxEventDispatched('PRESENCE_UPDATE', (payload: unknown) => {
				try {
					const settings = current()
					const record = asRecord(payload)
					if (settings.enabled === false || settings.presence === false)
						return payload
					const user = asRecord(record.user)
					const id = record.userId == null ? String(user.id ?? '') : String(record.userId)
					if (!id || !settings.people?.[id]) return payload
					const direct = record.status
					const presence = asRecord(record.presence)
					const status =
						typeof direct === 'string'
							? direct
							: typeof presence.status === 'string'
								? presence.status
								: ''
					if (!status) return payload
					const before = statuses.get(id)
					statuses.set(id, status)
					// Only a change out of offline is worth a toast: a build that
					// reports presence every few seconds must not repeat it.
					if (before === 'offline' && status !== 'offline') {
						if (allowed('presence:' + id, PRESENCE_GAP_MS))
							toast(`${nameOf(id)} is online.`)
					}
				} catch (error) {
					logger?.warn?.('[Watchlist] presence failed', error)
				}
				return payload
			}),
		)

		cleanup(
			onFluxEventDispatched('TYPING_START', (payload: unknown) => {
				try {
					const settings = current()
					const record = asRecord(payload)
					if (settings.enabled === false || settings.typing === false)
						return payload
					const id = record.userId == null ? '' : String(record.userId)
					if (!id || !settings.people?.[id]) return payload
					if (allowed('typing:' + id, TYPING_GAP_MS))
						toast(`${nameOf(id)} is typing…`)
				} catch (error) {
					logger?.warn?.('[Watchlist] typing failed', error)
				}
				return payload
			}),
		)

		cleanup(
			onFluxEventDispatched('MESSAGE_CREATE', (payload: unknown) => {
				try {
					const settings = current()
					const record = asRecord(payload)
					const message = asRecord(record.message)
					const author = asRecord(message.author)
					if (settings.enabled === false || settings.messages === false)
						return payload
					const id = author.id == null ? '' : String(author.id)
					if (!id || id === selfId() || !settings.people?.[id]) return payload
					if (allowed('message:' + id, MESSAGE_GAP_MS))
						toast(`${nameOf(id)} sent a message.`)
				} catch (error) {
					logger?.warn?.('[Watchlist] message failed', error)
				}
				return payload
			}),
		)

		cleanup(
			addMessageMenuRows(props => {
				const message = asRecord(props.message) as MessageLike
				return message.author ? menuRows(message) : []
			}, logger),
		)
		logger?.log?.('[Watchlist] started')
	},
	stop() {
		live = null
		statuses.clear()
		lastToast.clear()
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const people = Object.values(settings.people ?? {}).sort((a, b) =>
			(a.name || '').localeCompare(b.name || ''),
		)
		const on = settings.enabled !== false
		return (
			<Page>
				<Intro text="Watchlist gives you a tap on the shoulder when someone you are watching comes online, starts typing to you, or sends you a message. It stays on this device." />
				<Hero
					title={people.length === 0 ? 'Nobody on the list' : `Watching ${people.length}`}
					line={
						people.length === 0
							? 'Hold a message and pick Watch to add someone.'
							: 'One toast per person per kind of event, never a wall of them.'
					}
					tone={people.length ? 'brand' : 'muted'}
				/>
				<Section title="Notifications" description="Off stops that kind of toast; the list is kept.">
					<SwitchRow
						label="Track this list"
						subLabel="Off stops every notification; the list is kept."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<SwitchRow
						label="When they come online"
						subLabel="One toast when they go from offline to online."
						value={settings.presence !== false}
						onChange={presence => set({ presence })}
					/>
					<SwitchRow
						label="When they start typing"
						subLabel="At most one toast per person every 15 seconds."
						value={settings.typing !== false}
						onChange={typing => set({ typing })}
					/>
					<SwitchRow
						label="When they send a message"
						subLabel="At most one toast per person every 5 seconds."
						value={settings.messages !== false}
						onChange={messages => set({ messages })}
					/>
				</Section>
				<Section
					title={`Watching (${people.length})`}
					description={people.length ? 'Tap a name to stop watching that person.' : undefined}
				>
					{people.length === 0 ? (
						<Row label="Nobody yet." subLabel="Hold a message and pick Watch." />
					) : (
						people.map(person => (
							<Row
								key={person.id}
								label={person.name || person.id}
								subLabel={`${person.id} — tap to stop watching`}
								onPress={() => {
									const next = { ...(settings.people ?? {}) }
									delete next[person.id]
									set({ people: next })
								}}
							/>
						))
					)}
				</Section>
				<Section title="How it stays quiet">
					<Row
						label="Coming online, once"
						subLabel="Only a change out of offline fires, so a client that repeats presence cannot spam you."
					/>
					<Row
						label="Everyone else is ignored"
						subLabel="Your own messages and anyone not on the list never produce a toast."
					/>
					<Note text="No account, no server, no token: the list lives in this plugin's own storage." />
				</Section>
			</Page>
		)
	},
})

import { asRecord } from '../../_shared/types'