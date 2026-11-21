// DM Deleter, by cenotaph. Hold a conversation in the plugin's settings to
// open its messages, see what is in it, pick the ones you sent, and delete
// them one at a time: every delete is followed by an uneven pause, a rate
// limit is waited out instead of hammered, and anything newer than the cutoff
// is left alone. Nothing from the other side is touched, because Discord does
// not let one account delete another account's messages anyway.
//
// Everything goes through Discord's own message actions (found at runtime), so
// the login token never leaves the client and the client's own request queue
// still sees every call.
import { Design } from '@valenced/discord/design'
import { getStore, Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { useEffect, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord, errorMessage } from '../../_shared/types'
import type { JsonStorage, Logger, StoreLike } from '../../_shared/types'

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
// Both screens live in the same settings page, so the run counters live in the
// module and the page subscribes to them.
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

// The ambient React declarations in types/ have no type parameter on `useState`,
// so `useState<T>` is a type error there. This one wrapper keeps the page's state
// typed and every setter checked, without a cast at each call site.
type Setter<T> = (next: T | ((previous: T) => T)) => void
function useValue<T>(initial: T): [T, Setter<T>] {
	return useState(initial) as [T, Setter<T>]
}

function useProgress(): Progress {
	const [, bump] = useValue(0)
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

function currentUserId(): string {
	try {
		const me = asRecord(store('UserStore')?.getCurrentUser?.())
		return String(me.id ?? '')
	} catch {
		return ''
	}
}

interface ChannelStoreLike extends StoreLike {
	getSortedPrivateChannels?(): unknown[]
	getDMUserIds?(): string[]
	getDMFromUserId?(userId: string): string | undefined
}

interface MessageActionsLike {
	deleteMessage(
		channelId: string,
		messageId: string,
		...rest: unknown[]
	): unknown
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
		const id = typeof entry === 'string' ? entry : String(inline.id ?? '')
		const direct = inline.globalName ?? inline.global_name ?? inline.username
		const name =
			typeof direct === 'string' && direct ? direct : id ? userName(id) : ''
		if (name) names.push(name)
	}
	if (names.length) return names.join(', ')
	const fallback = channel.name
	if (typeof fallback === 'string' && fallback) return fallback
	return `DM ${String(channel.id ?? '').slice(-4)}`
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

// ─── One message ─────────────────────────────────────────────────────────────
// What the message list shows, and what a delete acts on.
interface Item {
	id: string
	mine: boolean
	author: string
	text: string
	at: number
	tooNew: boolean
}

function pad(value: number): string {
	return (value < 10 ? '0' : '') + value
}

function when(at: number): string {
	if (!at) return ''
	const date = new Date(at)
	return (
		date.getFullYear() +
		'-' +
		pad(date.getMonth() + 1) +
		'-' +
		pad(date.getDate()) +
		' ' +
		pad(date.getHours()) +
		':' +
		pad(date.getMinutes())
	)
}

function toItem(raw: unknown, me: string, cutoff: number): Item | null {
	const message = asRecord(raw)
	const id = String(message.id ?? '')
	if (!id) return null
	const author = asRecord(message.author)
	const authorId = String(author.id ?? '')
	const named =
		author.globalName ?? author.global_name ?? author.username ?? author.name
	const at = Date.parse(String(message.timestamp ?? ''))
	const files = Array.isArray(message.attachments)
		? message.attachments.length
		: 0
	const embeds = Array.isArray(message.embeds) ? message.embeds.length : 0
	let text = typeof message.content === 'string' ? message.content.trim() : ''
	if (!text && files)
		text = files === 1 ? '1 attachment' : `${files} attachments`
	if (!text && embeds) text = embeds === 1 ? '1 embed' : `${embeds} embeds`
	if (!text) text = '(no text)'
	const mine = authorId === me
	const time = Number.isFinite(at) ? at : 0
	return {
		id,
		mine,
		author: mine
			? 'You'
			: typeof named === 'string' && named
				? named
				: authorId
					? userName(authorId) || 'someone'
					: 'unknown',
		text,
		at: time,
		tooNew: cutoff > 0 && time > 0 && time > cutoff,
	}
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
			note(`rate limited, waiting ${Math.ceil(wait / 1000)} s`)
			await sleep(wait)
		}
	}
	return 'refused'
}

async function fetchPage(
	channelId: string,
	before: string,
): Promise<unknown[]> {
	const fetcher = resolveHistory()
	if (!fetcher)
		throw new Error('this build does not give plugins message history')
	let result: unknown
	try {
		result = await fetcher({
			channelId,
			limit: PAGE,
			before: before || undefined,
		})
	} catch {
		// Some builds take the arguments in order instead of an object.
		result = await fetcher(channelId, before || undefined, PAGE)
	}
	if (Array.isArray(result)) return result
	const record = asRecord(result)
	if (Array.isArray(record.messages)) return record.messages
	return []
}

// ─── The runs ────────────────────────────────────────────────────────────────

// Delete the picked messages, in order, at the configured pace. `removed` is
// called after each one so the open list drops it straight away.
async function remove(
	conversation: Conversation,
	ids: string[],
	settings: Settings,
	removed: (id: string) => void,
): Promise<void> {
	stopping = false
	publish({
		...IDLE,
		active: true,
		channel: conversation.name,
		note: `deleting ${ids.length} message(s)`,
	})
	try {
		if (!resolveActions())
			throw new Error('this build does not expose message actions')
		for (let index = 0; index < ids.length; index++) {
			if (stopping) break
			const outcome = await erase(conversation.id, ids[index])
			if (outcome === 'deleted' || outcome === 'gone') {
				publish({ deleted: progress.deleted + 1 })
				removed(ids[index])
			} else {
				publish({ failed: progress.failed + 1 })
			}
			if (index === ids.length - 1 || stopping) continue
			const pause = pauseFor(settings)
			note(`waiting ${(pause / 1000).toFixed(1)} s`)
			await sleep(pause)
		}
		publish({ active: false, note: summary(stopping ? 'stopped' : 'finished') })
		log?.log?.(`[DM Deleter] ${conversation.name}: ${progress.note}`)
	} catch (error) {
		publish({ active: false, note: `stopped: ${errorMessage(error)}` })
		log?.warn?.(`[DM Deleter] ${errorMessage(error)}`)
	}
}

// The whole conversation at once: pages back to the start and deletes every
// message you sent that the age limit allows.
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
		settings.olderThanDays > 0 ? Date.now() - settings.olderThanDays * DAY : 0
	try {
		const me = currentUserId()
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
				if (outcome === 'deleted' || outcome === 'gone')
					publish({ deleted: progress.deleted + 1 })
				else publish({ failed: progress.failed + 1 })
				const pause = pauseFor(settings)
				note(`waiting ${(pause / 1000).toFixed(1)} s`)
				await sleep(pause)
			}
			if (stopping || !oldest || oldest === before) break
			before = oldest
			if (messages.length < PAGE) break
		}
		publish({ active: false, note: summary(stopping ? 'stopped' : 'finished') })
		log?.log?.(`[DM Deleter] ${conversation.name}: ${progress.note}`)
	} catch (error) {
		publish({ active: false, note: `stopped: ${errorMessage(error)}` })
		log?.warn?.(`[DM Deleter] ${errorMessage(error)}`)
	}
}

function confirmDelete(what: string, run: () => void) {
	const body =
		'Deletes ' +
		what +
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

// ─── Small pieces of UI ──────────────────────────────────────────────────────

function Chip(props: {
	label: string
	onPress?: () => void
	danger?: boolean
	disabled?: boolean
}) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={props.label}
			disabled={props.disabled === true}
			onPress={props.onPress}
			style={{
				backgroundColor: token('BACKGROUND_SECONDARY'),
				borderRadius: 10,
				opacity: props.disabled === true ? 0.45 : 1,
				paddingHorizontal: 12,
				paddingVertical: 9,
			}}
		>
			<Text
				style={{
					color:
						props.danger === true ? token('TEXT_DANGER') : token('TEXT_NORMAL'),
					fontWeight: '600',
				}}
			>
				{props.label}
			</Text>
		</Pressable>
	)
}

// One message in the open conversation: the pick box, who sent it and when, and
// what it said. Anything that cannot be deleted still shows, greyed out.
function MessageRow(props: {
	item: Item
	picked: boolean
	onPress: () => void
	// The ambient JSX types carry no IntrinsicAttributes, so `key` has to be
	// declared here for the message list below to compile.
	key?: string
}) {
	const { item, picked } = props
	const pickable = item.mine && !item.tooNew
	const tint = pickable ? token('TEXT_NORMAL') : token('TEXT_MUTED')
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`${item.author}: ${item.text}`}
			onPress={props.onPress}
			style={{ flexDirection: 'row', gap: 10, paddingVertical: 9 }}
		>
			<Text
				style={{
					color: picked ? token('BRAND_500') : tint,
					fontSize: 16,
				}}
			>
				{picked ? '☑' : pickable ? '☐' : '·'}
			</Text>
			<View style={{ flex: 1 }}>
				<View style={{ flexDirection: 'row', gap: 8 }}>
					<Text style={{ color: tint, flex: 1, fontWeight: '700' }}>
						{item.author}
					</Text>
					<Text style={{ color: token('TEXT_MUTED'), fontSize: 12 }}>
						{when(item.at)}
					</Text>
				</View>
				<Text style={{ color: tint }}>{item.text}</Text>
				{item.tooNew ? (
					<Text style={{ color: token('TEXT_MUTED'), fontSize: 12 }}>
						newer than the age limit, so it cannot be picked
					</Text>
				) : null}
				{!item.mine ? (
					<Text style={{ color: token('TEXT_MUTED'), fontSize: 12 }}>
						not yours, so it cannot be deleted
					</Text>
				) : null}
			</View>
		</Pressable>
	)
}
// ─── Settings page ───────────────────────────────────────────────────────────

type RowProps = Record<string, unknown>
type Row = (props: RowProps) => unknown
type Group = (props: { title?: string; children?: unknown }) => unknown
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
		const [list, setList] = useValue<Conversation[] | null>(null)
		const [error, setError] = useValue('')
		const [open, setOpen] = useValue<Conversation | null>(null)
		const [items, setItems] = useValue<Item[]>([])
		const [chosen, setChosen] = useValue<string[]>([])
		const [reading, setReading] = useValue(false)
		const [more, setMore] = useValue(false)
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

		const cutoff = (): number =>
			settings.olderThanDays > 0 ? Date.now() - settings.olderThanDays * DAY : 0

		const readPage = async (conversation: Conversation, before: string) => {
			setReading(true)
			setError('')
			try {
				const me = currentUserId()
				if (!me) throw new Error('could not read your account')
				const raw = await fetchPage(conversation.id, before)
				const next: Item[] = []
				for (const one of raw) {
					const item = toItem(one, me, cutoff())
					if (item) next.push(item)
				}
				if (!mounted.current) return
				setItems(current => {
					if (!before) return next
					const seen = new Set(current.map(item => item.id))
					return [...current, ...next.filter(item => !seen.has(item.id))]
				})
				setMore(raw.length >= PAGE)
			} catch (problem) {
				if (mounted.current) setError(errorMessage(problem))
			} finally {
				if (mounted.current) setReading(false)
			}
		}

		const browse = (conversation: Conversation) => {
			setOpen(conversation)
			setItems([])
			setChosen([])
			setMore(true)
			void readPage(conversation, '')
		}

		const readOlder = () => {
			if (!open || reading || !more || !items.length) return
			void readPage(open, items[items.length - 1].id)
		}

		const toggle = (item: Item) => {
			if (running.active) return
			if (!item.mine) {
				note('that message is not yours, so it cannot be deleted')
				return
			}
			if (item.tooNew) {
				note(`that message is newer than ${settings.olderThanDays} days`)
				return
			}
			setChosen(current =>
				current.includes(item.id)
					? current.filter(id => id !== item.id)
					: [...current, item.id],
			)
		}

		const selectMine = () => {
			const eligible = items
				.filter(item => item.mine && !item.tooNew)
				.map(item => item.id)
			const everything =
				eligible.length > 0 && eligible.every(id => chosen.includes(id))
			setChosen(everything ? [] : eligible)
		}

		const deleteChosen = () => {
			if (!open || running.active || !chosen.length) return
			const ids = [...chosen]
			confirmDelete(
				ids.length +
					' message' +
					(ids.length === 1 ? '' : 's') +
					' you sent in ' +
					open.name,
				() => {
					void remove(open, ids, settings, id => {
						if (!mounted.current) return
						setItems(current => current.filter(item => item.id !== id))
						setChosen(current => current.filter(one => one !== id))
					})
				},
			)
		}

		const deleteEverything = () => {
			if (!open || running.active || settings.enabled === false) return
			confirmDelete(`every message you sent in ${open.name}`, () => {
				void clear(open, settings)
			})
		}

		const D = (Design ?? {}) as unknown as Ui
		const muted = token('TEXT_MUTED')
		const danger = token('TEXT_DANGER')

		// ── The open conversation ────────────────────────────────────────────
		if (open) {
			const eligible = items.filter(item => item.mine && !item.tooNew)
			const every =
				eligible.length > 0 && eligible.every(item => chosen.includes(item.id))
			const close = () => {
				if (running.active) return
				setOpen(null)
				setItems([])
				setChosen([])
				setError('')
			}
			return (
				<ScrollView style={settingsScroll}>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Back to your DMs"
						disabled={running.active}
						onPress={close}
						style={{ paddingVertical: 12 }}
					>
						<Text style={{ color: token('BRAND_500'), fontWeight: '700' }}>
							‹ Your DMs
						</Text>
					</Pressable>

					<Text
						style={{
							color: token('TEXT_NORMAL'),
							fontSize: 18,
							fontWeight: '700',
						}}
					>
						Delete msgs
					</Text>
					<Text style={{ color: muted, marginTop: 2 }}>
						{open.name} · {items.length} shown · {eligible.length} yours to
						delete
					</Text>

					<View
						style={{
							flexDirection: 'row',
							flexWrap: 'wrap',
							gap: 8,
							marginTop: 12,
						}}
					>
						<Chip
							label={
								every
									? 'Clear selection'
									: `Select all mine (${eligible.length})`
							}
							disabled={running.active || !eligible.length}
							onPress={selectMine}
						/>
						<Chip
							label={`Delete selected (${chosen.length})`}
							danger
							disabled={running.active || !chosen.length}
							onPress={deleteChosen}
						/>
						{running.active ? (
							<Chip
								label="Stop"
								danger
								onPress={() => {
									stopping = true
									note('stopping after this message')
								}}
							/>
						) : null}
					</View>

					{running.note ? (
						<Text style={{ color: muted, marginTop: 10 }}>
							{running.deleted} deleted · {running.failed} refused ·{' '}
							{running.note}
						</Text>
					) : null}
					{error ? (
						<Text style={{ color: danger, marginTop: 10 }}>{error}</Text>
					) : null}

					<View style={{ marginTop: 6 }}>
						{items.map(item => (
							<MessageRow
								key={item.id}
								item={item}
								picked={chosen.includes(item.id)}
								onPress={() => toggle(item)}
							/>
						))}
					</View>

					{reading && !items.length ? (
						<Text style={{ color: muted, marginTop: 12 }}>
							Reading the messages…
						</Text>
					) : null}
					{!reading && !items.length && !error ? (
						<Text style={{ color: muted, marginTop: 12 }}>
							No messages here.
						</Text>
					) : null}

					<View style={{ marginTop: 12 }}>
						<Chip
							label={
								reading
									? 'Reading…'
									: more
										? 'Load older messages'
										: 'No older messages'
							}
							disabled={reading || !more}
							onPress={readOlder}
						/>
					</View>

					<View style={{ gap: 8, marginTop: 16, marginBottom: 24 }}>
						<Text style={{ color: muted }}>
							Tap a message of yours to pick it, then Delete selected.
							{settings.olderThanDays > 0
								? ' Anything from the last ' +
									settings.olderThanDays +
									' days stays out of reach.'
								: ' Everything you sent is eligible.'}
						</Text>
						<Chip
							label="Delete everything I sent"
							danger
							disabled={running.active || settings.enabled === false}
							onPress={deleteEverything}
						/>
						<Text style={{ color: danger }}>
							Deleting can never be undone, and it is always your own account
							making the request.
						</Text>
					</View>
				</ScrollView>
			)
		}

		// ── Settings and the conversation list ───────────────────────────────
		if (!D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						DM Deleter needs the settings rows this build does not have.
					</Text>
				</ScrollView>
			)
		}

		const supported = resolveActions() !== null
		const begin = (conversation: Conversation) => {
			if (running.active) return
			browse(conversation)
		}

		const rows = (list ?? []).map(entry =>
			D.TableRow ? (
				<Pressable
					key={entry.id}
					accessibilityLabel={`Delete msgs in ${entry.name}`}
					delayLongPress={450}
					disabled={running.active}
					onLongPress={() => begin(entry)}
					onPress={() => begin(entry)}
				>
					<D.TableRow
						label={entry.name}
						subLabel={`${entry.group ? 'Group DM · ' : ''}hold to delete msgs`}
						onPress={() => begin(entry)}
					/>
				</Pressable>
			) : (
				<Pressable
					key={entry.id}
					accessibilityLabel={`Delete msgs in ${entry.name}`}
					style={{ paddingVertical: 10 }}
					onLongPress={() => begin(entry)}
					onPress={() => begin(entry)}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>{entry.name}</Text>
					<Text style={{ color: muted }}>hold to delete msgs</Text>
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
							subLabel="Anything newer is shown but cannot be picked, so a delete cannot be aimed at a live conversation."
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
							label={`Pause between deletes: ${(delay / 1000).toFixed(1)} s`}
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
							running.active ? `Deleting in ${running.channel}` : 'Last run'
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
						Hold a conversation to see its messages and delete the ones you
						sent.
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
