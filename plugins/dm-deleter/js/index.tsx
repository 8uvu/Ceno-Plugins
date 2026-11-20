// DM Deleter, by cenotaph. Deletes the messages you sent in a DM, one at a
// time: every delete is followed by an uneven pause, a rate limit is waited
// out instead of hammered, and anything newer than the cutoff is left alone.
// Nothing from the other side is touched, because Discord does not let one
// account delete another account's messages anyway.
//
// Everything goes through Discord's own message actions (found at runtime), so
// the login token never leaves the client and the client's own request queue
// still sees every call.
import { Design } from '@valenced/discord/design'
import { Stores, getStore } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord, errorMessage } from '../../_shared/types'
import type { JsonStorage, Logger, StoreLike } from '../../_shared/types'
import type { ReactNode } from 'react'

interface Settings {
	enabled: boolean
	// Base pause between two deletes. The request asked for 2.5 s.
	delayMs: number
	// +-50% around the base, so the gaps are never identical.
	jitter: boolean
	// 0 turns the age filter off; anything else is a number of days.
	olderThanDays: number
}

const DEFAULTS: Settings = {
	enabled: true,
	delayMs: 2500,
	jitter: true,
	olderThanDays: 7,
}

const DELAY_CHOICES = [1500, 2000, 2500, 3000, 4000, 5000]
const PAGE = 100
const MAX_PAGES = 2000
const DAY = 86400000
const DM = 1
const GROUP_DM = 3

let log: Logger | undefined

// ─── Progress ────────────────────────────────────────────────────────────────
// The settings page is the only screen this plugin has, so the run counters
// live in the module and the page subscribes to them.

interface Progress {
	active: boolean
	channel: string
	deleted: number
	kept: number
	failed: number
	note: string
}

const IDLE: Progress = {
	active: false,
	channel: '',
	deleted: 0,
	kept: 0,
	failed: 0,
	note: '',
}

let progress: Progress = { ...IDLE }
let stopping = false
const listeners = new Set<() => void>()

function publish(patch: Partial<Progress>) {
	progress = { ...progress, ...patch }
	for (const listener of listeners) {
		try {
			listener()
		} catch {}
	}
}

function note(text: string) {
	publish({ note: text })
}

function summary(headline: string): string {
	return (
		headline +
		': ' +
		progress.deleted +
		' deleted, ' +
		progress.kept +
		' too new, ' +
		progress.failed +
		' refused'
	)
}

function useProgress(): Progress {
	const [, bump] = useState(0)
	useEffect(() => {
		let alive = true
		const listener = () => {
			if (alive) bump(value => value + 1)
		}
		listeners.add(listener)
		return () => {
			alive = false
			listeners.delete(listener)
		}
	}, [])
	return progress
}

// ─── Discord internals ───────────────────────────────────────────────────────

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

interface ChannelStoreLike extends StoreLike {
	getSortedPrivateChannels?(): unknown[]
	getDMUserIds?(): string[]
	getDMFromUserId?(userId: string): string | undefined
}

interface MessageActionsLike {
	deleteMessage(channelId: string, messageId: string, ...rest: unknown[]): unknown
	fetchMessages?: (...args: unknown[]) => unknown
}

let actions: MessageActionsLike | null = null
let history: ((...args: unknown[]) => unknown) | null = null

// The message action module is found by its exports, not by a path: Discord
// moves files between releases but keeps sendMessage and deleteMessage together.
function resolveActions(): MessageActionsLike | null {
	if (actions) return actions
	let found: unknown = null
	try {
		const [module] = lookupModule(
			withProps('deleteMessage', 'sendMessage'),
		) as [unknown, number | undefined]
		found = module
	} catch {
		return null
	}
	const record = asRecord(found)
	if (typeof record.deleteMessage !== 'function') return null
	const resolved = found as unknown as MessageActionsLike
	if (typeof record.fetchMessages === 'function') {
		history = resolved.fetchMessages ?? null
	}
	actions = resolved
	return actions
}

function resolveHistory(): ((...args: unknown[]) => unknown) | null {
	if (history) return history
	try {
		const [module] = lookupModule(withProps('fetchMessages')) as [
			unknown,
			number | undefined,
		]
		const record = asRecord(module)
		if (typeof record.fetchMessages === 'function') {
			history = record.fetchMessages as (...args: unknown[]) => unknown
		}
	} catch {}
	return history
}

function userName(id: string): string {
	try {
		const user = asRecord(store('UserStore')?.getUser?.(id))
		const name = user.globalName ?? user.global_name ?? user.username
		if (typeof name === 'string' && name) return name
	} catch {}
	return ''
}

function conversationName(channel: Record<string, unknown>): string {
	const recipients = Array.isArray(channel.recipients) ? channel.recipients : []
	const names: string[] = []
	for (const entry of recipients) {
		const inline = asRecord(entry)
		const id =
			typeof entry === 'string' ? entry : String(inline.id ?? '')
		const direct = inline.globalName ?? inline.global_name ?? inline.username
		const name =
			typeof direct === 'string' && direct ? direct : id ? userName(id) : ''
		if (name) names.push(name)
	}
	if (names.length) return names.join(', ')
	const fallback = channel.name
	if (typeof fallback === 'string' && fallback) return fallback
	return 'DM ' + String(channel.id ?? '').slice(-4)
}

interface Conversation {
	id: string
	name: string
	group: boolean
}

function conversations(): Conversation[] {
	const channels = store('ChannelStore') as ChannelStoreLike | null
	const list: Conversation[] = []
	const seen = new Set<string>()
	const push = (channel: unknown) => {
		const record = asRecord(channel)
		const id = String(record.id ?? '')
		if (!id || seen.has(id)) return
		const type = typeof record.type === 'number' ? record.type : 0
		if (type !== DM && type !== GROUP_DM) return
		seen.add(id)
		list.push({ id, name: conversationName(record), group: type === GROUP_DM })
	}
	try {
		const sorted = channels?.getSortedPrivateChannels?.()
		if (Array.isArray(sorted)) for (const channel of sorted) push(channel)
	} catch {}
	if (!list.length) {
		// Older builds only expose the user map, which resolves the same DMs.
		try {
			for (const userId of channels?.getDMUserIds?.() ?? []) {
				const id = channels?.getDMFromUserId?.(userId)
				if (id) push(channels?.getChannel?.(id) ?? null)
			}
		} catch {}
	}
	return list
}

// ─── Pacing ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function pauseFor(settings: Settings): number {
	const base = Math.max(500, Number(settings.delayMs) || DEFAULTS.delayMs)
	if (settings.jitter === false) return base
	// 0.5x to 1.5x of the base: 1.25 s to 3.75 s at the default.
	return Math.round(base * (0.5 + Math.random()))
}

// How long a failed delete asks us to wait, or 0 when the error was not a
// rate limit. Discord's own queue retries already; this keeps our own loop from
// piling more work on top of it.
function rateLimitWait(error: unknown): number {
	const record = asRecord(error)
	const body = asRecord(record.body)
	const seconds =
		typeof body.retry_after === 'number'
			? body.retry_after
			: typeof record.retry_after === 'number'
				? record.retry_after
				: 0
	const limited =
		record.status === 429 ||
		seconds > 0 ||
		/rate.?limit|429/i.test(errorMessage(error))
	if (!limited) return 0
	const wait = seconds > 0 ? seconds * 1000 : 5000
	return Math.min(60000, Math.round(wait)) + Math.round(Math.random() * 2000)
}

async function erase(
	channelId: string,
	messageId: string,
): Promise<'deleted' | 'gone' | 'refused'> {
	const api = resolveActions()
	if (!api) throw new Error('this build does not expose message actions')
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await api.deleteMessage(channelId, messageId)
			return 'deleted'
		} catch (error) {
			const wait = rateLimitWait(error)
			if (!wait) {
				if (/\b404\b|unknown message/i.test(errorMessage(error))) return 'gone'
				log?.warn?.('[DM Deleter] delete refused', error)
				return 'refused'
			}
			note('rate limited, waiting ' + Math.ceil(wait / 1000) + ' s')
			await sleep(wait)
		}
	}
	return 'refused'
}

async function fetchPage(channelId: string, before: string): Promise<unknown[]> {
	const fetcher = resolveHistory()
	if (!fetcher)
		throw new Error('this build does not give plugins message history')
	let result: unknown
	try {
		result = await fetcher({ channelId, limit: PAGE, before: before || undefined })
	} catch {
		// Some builds take the arguments in order instead of an object.
		result = await fetcher(channelId, before || undefined, PAGE)
	}
	if (Array.isArray(result)) return result
	const record = asRecord(result)
	if (Array.isArray(record.messages)) return record.messages
	return []
}

// ─── The run ─────────────────────────────────────────────────────────────────

async function clear(
	conversation: Conversation,
	settings: Settings,
): Promise<void> {
	stopping = false
	publish({
		...IDLE,
		active: true,
		channel: conversation.name,
		note: 'reading the conversation',
	})
	const cutoff =
		settings.olderThanDays > 0
			? Date.now() - settings.olderThanDays * DAY
			: 0
	try {
		const me = String(store('UserStore')?.getCurrentUser?.()?.id ?? '')
		if (!me) throw new Error('could not read your account')
		let before = ''
		const seen = new Set<string>()
		for (let page = 0; page < MAX_PAGES; page++) {
			if (stopping) break
			const messages = await fetchPage(conversation.id, before)
			if (!messages.length) break
			const oldest = String(asRecord(messages[messages.length - 1]).id ?? '')
			for (const raw of messages) {
				if (stopping) break
				const message = asRecord(raw)
				if (String(asRecord(message.author).id ?? '') !== me) continue
				const at = Date.parse(String(message.timestamp ?? ''))
				if (cutoff && Number.isFinite(at) && at > cutoff) {
					publish({ kept: progress.kept + 1 })
					continue
				}
				const id = String(message.id ?? '')
				if (!id || seen.has(id)) continue
				seen.add(id)
				const outcome = await erase(conversation.id, id)
				if (outcome === 'deleted') publish({ deleted: progress.deleted + 1 })
				else if (outcome === 'refused') publish({ failed: progress.failed + 1 })
				const pause = pauseFor(settings)
				note('waiting ' + (pause / 1000).toFixed(1) + ' s')
				await sleep(pause)
			}
			if (stopping || !oldest || oldest === before) break
			before = oldest
			if (messages.length < PAGE) break
		}
		publish({ active: false, note: summary(stopping ? 'stopped' : 'finished') })
		log?.log?.('[DM Deleter] ' + conversation.name + ': ' + progress.note)
	} catch (error) {
		publish({ active: false, note: 'stopped: ' + errorMessage(error) })
		log?.warn?.('[DM Deleter] ' + errorMessage(error))
	}
}

function confirmDelete(name: string, run: () => void) {
	const body =
		'Deletes the messages you sent in ' +
		name +
		', one at a time with a pause between each. This cannot be undone.'
	try {
		Alert.alert('Delete your messages?', body, [
			{ text: 'Cancel', style: 'cancel' },
			{ text: 'Delete', style: 'destructive', onPress: run },
		])
	} catch {
		// No alert on this build: refusing is safer than deleting unasked.
		note('could not ask for confirmation on this build')
	}
}

// ─── Settings page ───────────────────────────────────────────────────────────

type RowProps = Record<string, unknown>
type Row = (props: RowProps) => ReactNode
type Group = (props: { title?: string; children?: unknown }) => ReactNode

interface Ui {
	TableRowGroup?: Group
	TableRow?: Row
	TableSwitchRow?: Row
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ logger }) {
		log = logger
		log?.log?.('[DM Deleter] ready')
	},
	stop() {
		stopping = true
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings = api.jsonStorage.use() ?? DEFAULTS
		const running = useProgress()
		const [list, setList] = useState<Conversation[] | null>(null)
		const [error, setError] = useState('')
		const mounted = useRef(true)

		const load = () => {
			setError('')
			setList(null)
			try {
				const found = conversations()
				if (mounted.current) setList(found)
			} catch (problem) {
				if (mounted.current) {
					setList([])
					setError(errorMessage(problem))
				}
			}
		}

		useEffect(() => {
			mounted.current = true
			load()
			return () => {
				mounted.current = false
			}
		}, [])

		const save = (patch: Partial<Settings>) => {
			api.jsonStorage.set(patch).catch?.(() => {})
		}

		const delay = settings.delayMs || DEFAULTS.delayMs
		const nextDelay = () => {
			const index = DELAY_CHOICES.indexOf(delay)
			save({ delayMs: DELAY_CHOICES[(index + 1) % DELAY_CHOICES.length] })
		}

		const begin = (conversation: Conversation) => {
			if (running.active || settings.enabled === false) return
			confirmDelete(conversation.name, () => {
				void clear(conversation, settings)
			})
		}

		const D = (Design ?? {}) as unknown as Ui
		if (!D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						DM Deleter needs the settings rows this build does not have.
					</Text>
				</ScrollView>
			)
		}

		const muted = token('TEXT_MUTED')
		const danger = token('TEXT_DANGER')
		const supported = resolveActions() !== null

		const rows = (list ?? []).map(entry =>
			D.TableRow ? (
				<Pressable
					key={entry.id}
					delayLongPress={450}
					disabled={running.active || settings.enabled === false}
					onLongPress={() => begin(entry)}
					accessibilityLabel={
						'Hold to delete your messages in ' + entry.name
					}
				>
					<D.TableRow
						label={entry.name}
						subLabel={
							(entry.group ? 'Group DM · ' : '') +
							'hold to delete the messages you sent'
						}
					/>
				</Pressable>
			) : (
				<Pressable
					key={entry.id}
					style={{ paddingVertical: 10 }}
					onLongPress={() => begin(entry)}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>{entry.name}</Text>
					<Text style={{ color: muted }}>
						hold to delete the messages you sent
					</Text>
				</Pressable>
			),
		)

		return (
			<ScrollView style={settingsScroll}>
				<D.TableRowGroup title="DM Deleter">
					{D.TableSwitchRow ? (
						<D.TableSwitchRow
							label="Allow deleting"
							subLabel="Turns the hold gesture off without uninstalling the plugin."
							value={settings.enabled !== false}
							onValueChange={(value: boolean) => save({ enabled: value })}
						/>
					) : null}
					{D.TableSwitchRow ? (
						<D.TableSwitchRow
							label="Only messages older than 7 days"
							subLabel="Anything newer is skipped, so a delete cannot be aimed at a live conversation."
							value={settings.olderThanDays > 0}
							onValueChange={(value: boolean) =>
								save({ olderThanDays: value ? 7 : 0 })
							}
						/>
					) : null}
					{D.TableSwitchRow ? (
						<D.TableSwitchRow
							label="Vary the pause (+-50%)"
							subLabel="Uneven gaps look less like a script than a fixed timer."
							value={settings.jitter !== false}
							onValueChange={(value: boolean) => save({ jitter: value })}
						/>
					) : null}
					{D.TableRow ? (
						<D.TableRow
							label={
								'Pause between deletes: ' + (delay / 1000).toFixed(1) + ' s'
							}
							subLabel="Tap to change. 2.5 s is a safe pace."
							onPress={nextDelay}
						/>
					) : null}
					{D.TableRow ? (
						<D.TableRow
							label="Refresh the conversation list"
							subLabel="Re-reads your DMs from Discord."
							onPress={load}
						/>
					) : null}
				</D.TableRowGroup>

				{running.active || running.note ? (
					<D.TableRowGroup
						title={
							running.active
								? 'Deleting in ' + running.channel
								: 'Last run'
						}
					>
						{D.TableRow ? (
							<D.TableRow
								label={
									running.deleted +
									' deleted · ' +
									running.kept +
									' too new · ' +
									running.failed +
									' refused'
								}
								subLabel={running.note}
							/>
						) : null}
						{running.active && D.TableRow ? (
							<D.TableRow
								label="Stop"
								subLabel="Finishes the message being deleted, then stops cleanly."
								onPress={() => {
									stopping = true
									note('stopping after this message')
								}}
							/>
						) : null}
					</D.TableRowGroup>
				) : null}

				<D.TableRowGroup title="Your DMs">
					{!supported && D.TableRow ? (
						<D.TableRow
							label="Not supported on this build"
							subLabel="This client does not expose message actions to plugins, so nothing can be deleted."
						/>
					) : null}
					{error && D.TableRow ? (
						<D.TableRow label="Could not read your DMs" subLabel={error} />
					) : null}
					{list === null && D.TableRow ? (
						<D.TableRow label="Reading your DMs…" />
					) : null}
					{list !== null && list.length === 0 && !error && D.TableRow ? (
						<D.TableRow label="No DMs found." />
					) : null}
					{rows}
				</D.TableRowGroup>

				<View style={{ paddingBottom: 24 }}>
					<Text style={{ color: muted }}>
						Hold a conversation to delete the messages you sent there.
						{settings.olderThanDays > 0
							? ' Anything from the last ' +
								settings.olderThanDays +
								' days is left alone.'
							: ' Everything you sent is eligible.'}
					</Text>
					<Text style={{ color: danger, marginTop: 8 }}>
						Deleting can never be undone, and it is always your own account
						making the request.
					</Text>
				</View>
			</ScrollView>
		)
	},
})
