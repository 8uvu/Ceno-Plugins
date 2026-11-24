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
import { Pressable, ScrollView, Text, View } from 'react-native'
import { addMessageMenuRows } from '../../_shared/actionSheet'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord } from '../../_shared/types'
import type {
	DesignComponent,
	DesignShim,
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
	SettingsComponent({
		api,
	}: {
		api: {
			jsonStorage: JsonStorage<Settings> | {
				use(): unknown
				set(patch: Partial<Settings>): Promise<unknown>
			}
		}
	}) {
		const settings = ((api.jsonStorage.use() as unknown) ?? DEFAULTS) as Settings
		const set = (patch: Partial<Settings>) => {
			Promise.resolve(api.jsonStorage.set(patch)).catch?.(() => {})
		}
		const people = Object.values(settings.people ?? {}).sort((a, b) =>
			(a.name || '').localeCompare(b.name || ''),
		)
		const D = (Design ?? {}) as unknown as DesignShim
		const normal = token('TEXT_NORMAL')
		const muted = token('TEXT_MUTED')

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
					<D.TableRowGroup
						title="Watchlist"
						description="Hold a message and pick Watch to be told when that person comes online, types to you, or sends a message."
					>
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Track this list"
								subLabel="Off stops every notification; the list is kept."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="When they come online"
								subLabel="One toast when they go from offline to online."
								value={settings.presence !== false}
								onValueChange={(v: boolean) => set({ presence: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="When they start typing"
								subLabel="At most one toast per person every 15 seconds."
								value={settings.typing !== false}
								onValueChange={(v: boolean) => set({ typing: v })}
							/>
						) : null}
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="When they send a message"
								subLabel="At most one toast per person every 5 seconds."
								value={settings.messages !== false}
								onValueChange={(v: boolean) => set({ messages: v })}
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup
						title={`Watching (${people.length})`}
						description="Tap a name to stop watching that person."
					>
						{people.length === 0
							? row('empty', 'Nobody yet.', 'Hold a message and pick Watch.')
							: people.map(person =>
									D.TableRow ? (
										<D.TableRow
											key={person.id}
											label={person.name || person.id}
											subLabel={`${person.id} — tap to stop watching`}
											onPress={() => {
												const next = { ...(settings.people ?? {}) }
												delete next[person.id]
												set({ people: next })
											}}
										/>
									) : (
										row(
											person.id,
											person.name || person.id,
											'Tap to stop watching',
										)
									),
								)}
					</D.TableRowGroup>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: normal, fontWeight: 'bold' }}>Watchlist</Text>
				<Text style={{ color: muted }}>
					Hold a message and pick Watch to be told when that person is around.
				</Text>
				<Pressable
					accessibilityLabel="Track this list"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Track this list: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Text style={{ color: normal, marginTop: 8 }}>
					Watching {people.length}:
				</Text>
				{people.length === 0 ? (
					<Text style={{ color: muted }}>Nobody yet.</Text>
				) : (
					people.map(person => (
						<Pressable
							key={person.id}
							accessibilityLabel={'Stop watching ' + (person.name || person.id)}
							onPress={() => {
								const next = { ...(settings.people ?? {}) }
								delete next[person.id]
								set({ people: next })
							}}
							style={{ paddingVertical: 6 }}
						>
							<Text style={{ color: normal }}>{person.name || person.id}</Text>
						</Pressable>
					))
				)}
			</ScrollView>
		)
	},
})
