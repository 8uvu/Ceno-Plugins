// Last Seen, by cenotaph. Keeps a local record of when people came online and
// when they went away, so "were they around?" has an answer after the fact.
//
// Discord sends presence updates constantly — an activity change is not coming
// or going — so only a real change of state is written, and only the latest
// change per person is kept. Nothing is uploaded, nothing is requested, and the
// record starts when the plugin does: it cannot know about time it was not
// running, and the page says so.
import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ago, selfId, span, userName } from '../../_shared/lookup'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord } from '../../_shared/types'
import type { DesignShim, JsonStorage, Logger } from '../../_shared/types'

interface Person {
	name: string
	online: boolean
	// When they last came online, and when they last went away.
	lastOnline: number
	lastOffline: number
	// The last change of either kind, used to order and to cap the list.
	at: number
}

interface Settings {
	enabled: boolean
	people: Record<string, Person>
}

const DEFAULTS: Settings = { enabled: true, people: {} }

// A ceiling, so a big server cannot grow the storage file without end.
const MAX_PEOPLE = 200

let logger: Logger | undefined
// The framework's storage type is looser than these settings, so only what is
// used is declared here and the cache is cast on read.
let live: {
	cache?: unknown
	set(patch: Partial<Settings>): Promise<unknown>
} | null = null

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

function peopleOf(settings: Settings): Record<string, Person> {
	const people = settings.people
	return people && typeof people === 'object' ? people : {}
}

// Presence arrives with activities attached and repeats; only a change of state
// or of name is worth writing.
function remember(payload: unknown): void {
	const settings = current()
	if (settings.enabled === false) return
	const record = asRecord(payload)
	const user = asRecord(record.user)
	const id = typeof user.id === 'string' ? user.id : ''
	if (!id) return
	const me = selfId()
	if (me && id === me) return
	const status = typeof record.status === 'string' ? record.status : ''
	// A payload without a status says nothing about coming or going.
	if (!status) return
	const online = status !== 'offline'
	const people = peopleOf(settings)
	const existing = people[id]
	const rawName = user.globalName ?? user.global_name ?? user.username
	const name =
		typeof rawName === 'string' && rawName
			? rawName
			: existing?.name || userName(id)
	if (existing && existing.online === online && existing.name === name) return
	const now = Date.now()
	const next: Person = {
		name,
		online,
		lastOnline: online ? now : (existing?.lastOnline ?? 0),
		lastOffline: online ? (existing?.lastOffline ?? 0) : now,
		at: now,
	}
	const kept = Object.entries({ ...people, [id]: next })
		.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
		.slice(0, MAX_PEOPLE)
	write({ people: Object.fromEntries(kept) })
}

function describe(person: Person, now: number): string {
	if (person.online) {
		return person.lastOnline ? 'online for ' + span(now - person.lastOnline) : 'online'
	}
	return person.lastOffline
		? 'last seen ' + ago(person.lastOffline, now)
		: 'seen away'
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		cleanup(
			// A listener only: the payload goes back untouched.
			onFluxEventDispatched('PRESENCE_UPDATE', (payload: unknown) => {
				try {
					remember(payload)
				} catch (error) {
					logger?.warn?.('[Last Seen] skipped a presence update', error)
				}
				return payload
			}),
		)
		logger?.log?.('[Last Seen] started')
	},
	stop() {
		live = null
	},
	SettingsComponent({
		api,
	}: {
		api: { jsonStorage: JsonStorage<Settings> }
	}) {
		const settings = (api.jsonStorage.use() ?? DEFAULTS) as Settings
		const set = (patch: Partial<Settings>) => {
			Promise.resolve(api.jsonStorage.set(patch)).catch?.(() => {})
		}
		const now = Date.now()
		const people = peopleOf(settings)
		const entries = Object.entries(people)
		const online = entries
			.filter(([, person]) => person.online)
			.sort((a, b) => (b[1].lastOnline ?? 0) - (a[1].lastOnline ?? 0))
		const away = entries
			.filter(([, person]) => !person.online)
			.sort((a, b) => (b[1].lastOffline ?? 0) - (a[1].lastOffline ?? 0))
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

		const personRow = ([id, person]: [string, Person]) =>
			row(
				id,
				person.name || userName(id),
				describe(person, now),
			)

		if (D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<D.TableRowGroup
						title="Last Seen"
						description="Records when people came online and when they went away. It starts when the plugin starts, so time before that is not known."
					>
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Record presence"
								subLabel="Off stops recording; what is already recorded stays."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label={`Forget everyone (${entries.length})`}
								subLabel="Deletes the whole record from this device."
								onPress={() => set({ people: {} })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="How it knows"
								subLabel="Only changes Discord announces while the app is open. Someone who never changed state while the plugin ran is not listed."
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup
						title={online.length === 0 ? 'Nobody online now' : `Online now (${online.length})`}
					>
						{online.length === 0
							? row('empty-online', 'Nobody online right now.')
							: online.map(personRow)}
					</D.TableRowGroup>
					<D.TableRowGroup
						title={away.length === 0 ? 'Nobody away yet' : `Last seen (${away.length})`}
						description="Most recent first."
					>
						{away.length === 0
							? row('empty-away', 'Nothing recorded yet.')
							: away.map(personRow)}
					</D.TableRowGroup>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: normal, fontWeight: 'bold' }}>Last Seen</Text>
				<Text style={{ color: muted }}>
					Records when people came online and when they went away.
				</Text>
				<Pressable
					accessibilityLabel="Record presence"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Record presence: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Forget everyone"
					onPress={() => set({ people: {} })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>Forget everyone ({entries.length})</Text>
				</Pressable>
				{entries.length === 0 ? (
					<Text style={{ color: muted, marginTop: 8 }}>
						Nothing recorded yet.
					</Text>
				) : (
					[...online, ...away].map(([id, person]) => (
						<Text key={id} style={{ color: normal, marginTop: 6 }}>
							{person.name || userName(id)} — {describe(person, now)}
						</Text>
					))
				)}
			</ScrollView>
		)
	},
})
