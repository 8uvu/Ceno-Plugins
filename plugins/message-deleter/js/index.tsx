// Message Deleter, by cenotaph.
//
// A phone port of the author's own Equicord plugin "MessageCleaner", in English.
// It does one thing and asks nothing else of you:
//
//   * hold a message you sent and choose "Delete this message";
//   * hold any message in a DM (or hold the DM itself in the chat list) and
//     choose "Delete all my messages" — every message you sent in that chat is
//     deleted, newest first, one request at a time, with a pause between them;
//   * while a run is going, the same menu offers "Stop deleting".
//
// The run reads the chat a page at a time and deletes as it goes, so it works on
// a conversation of any length. A 429 is waited out for exactly the delay
// Discord names, never worked around, and a second refusal stops the run rather
// than retrying into the limit.
//
// Everything goes through the client's own message actions (or its own HTTP
// module when a build has no action), so the login token never leaves Discord,
// and only this account's own messages are ever touched.
import {
	ActionSheetActionCreators,
	ToastActionCreators,
} from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { createElement } from 'react'
import { Alert } from 'react-native'
import {
	Hero,
	Intro,
	Page,
	Row,
	Section,
} from '../../_shared/lib/kit'
import { useSettings } from '../../_shared/lib/settings'
import { asRecord, errorMessage } from '../../_shared/types'
import type { DesignComponent, DesignShim, Logger } from '../../_shared/types'

// A DM and a group DM are the places this plugin offers itself. A guild channel
// is somebody else's server; a single message can still be deleted there, but
// not a whole history.
const DM = 1
const GROUP_DM = 3

// One page of history per request, the size Discord's own client asks for.
const PAGE_LIMIT = 50
// Between two deletes, so the run is a walk and not a burst. This is the same
// second the desktop plugin waits by default.
const PAUSE_MS = 1000
// A ceiling for one run, so a mistake cannot walk a channel forever.
const MAX_PAGES = 200
// Discord's retry_after is honoured as given; this only rounds up and adds a
// small margin, so a retry can never be earlier than the limit allows.
const WAIT_MARGIN_MS = 250
// Past this, waiting is worse than saying so: the run stops and reports the
// limit instead of holding a request open.
const MAX_WAIT_MS = 60000
// The sheet is already closing when a row is pressed, so the next surface is
// shown after it has gone rather than underneath it.
const CONFIRM_DELAY_MS = 250

interface UserLike {
	id?: string
	username?: string
	globalName?: string
	global_name?: string
}

interface MessageLike {
	id?: string
	content?: string
	timestamp?: string
	author?: UserLike
	attachments?: unknown[]
	embeds?: unknown[]
	deleted?: boolean
	state?: string
}

interface ChannelLike {
	id?: string
	type?: number
	name?: string
	guild_id?: string
	guildId?: string
	recipients?: unknown[]
	rawRecipients?: unknown[]
}

interface SheetProps {
	message?: MessageLike
	channel?: ChannelLike
}

interface ChannelSheetProps {
	channel?: ChannelLike
	onClose?: () => void
}

interface RowComponent {
	(props: Record<string, unknown>): unknown
	Group?: DesignComponent
	Icon?: DesignComponent
}

interface MessageActionsLike {
	deleteMessage(channelId: string, messageId: string): unknown
}

interface HttpLike {
	get?(options: { url: string }): Promise<unknown>
	del?(options: { url: string }): Promise<unknown>
	delete?(options: { url: string }): Promise<unknown>
}

interface Stats {
	deleted: number
	failed: number
	scanned: number
}

let logger: Logger | undefined
let disposed = false
let running = false
let stopRequested = false
let failure = ''
let stats: Stats = { deleted: 0, failed: 0, scanned: 0 }
let resultText = 'Nothing deleted yet.'
let progressText = ''
// What the long-press menu reports in the settings page.
const diagnostics = {
	menu: 'Waiting for the message menu to load.',
	channelMenu: 'Waiting for the chat menu to load.',
	history: 'Not read yet.',
	actions: 'Not found yet.',
}
const timers = new Set<ReturnType<typeof setTimeout>>()

// ─── Reading the client ──────────────────────────────────────────────────────

function currentUserId(): string {
	try {
		const userStore = asRecord(asRecord(Stores).UserStore)
		if (typeof userStore.getCurrentUser !== 'function') return ''
		const user = asRecord((userStore.getCurrentUser as () => unknown)())
		return typeof user.id === 'string' ? user.id : ''
	} catch {
		return ''
	}
}

function mine(message?: MessageLike): boolean {
	const me = currentUserId()
	if (!me || !message) return false
	return typeof message.author?.id === 'string' && message.author.id === me
}

// What Discord will actually let this account delete: its own message, still
// there, and not one that is still sending.
function deletable(message: MessageLike): boolean {
	if (!mine(message)) return false
	if (message.deleted === true) return false
	if (message.state === 'SENDING' || message.state === 'FAILED') return false
	return typeof message.id === 'string' && message.id.length > 0
}

// A DM, a group DM, or a channel that reports no guild at all — the last case
// keeps the row visible on a build that leaves `type` out of the props.
function inDm(channel?: ChannelLike): boolean {
	if (!channel) return false
	if (channel.type === DM || channel.type === GROUP_DM) return true
	return !channel.guild_id && !channel.guildId
}

function channelIdOf(channel?: ChannelLike): string {
	return typeof channel?.id === 'string' ? channel.id : ''
}

function previewOf(message: MessageLike): string {
	let text = typeof message.content === 'string' ? message.content.trim() : ''
	const files = Array.isArray(message.attachments)
		? message.attachments.length
		: 0
	const embeds = Array.isArray(message.embeds) ? message.embeds.length : 0
	if (!text && files)
		text = files === 1 ? 'One attachment' : `${files} attachments`
	if (!text && embeds) text = embeds === 1 ? 'One embed' : `${embeds} embeds`
	if (!text) text = 'A message with no text'
	if (text.length > 160) text = `${text.slice(0, 157)}…`
	return text
}

function resolveActions(): MessageActionsLike | null {
	try {
		const [module] = lookupModule(
			withProps('deleteMessage', 'sendMessage'),
		) as [unknown, number | undefined]
		const record = asRecord(module)
		if (typeof record.deleteMessage === 'function') {
			diagnostics.actions = 'Discord’s own delete action was found.'
			return module as unknown as MessageActionsLike
		}
	} catch {}
	return null
}

function resolveHttp(): HttpLike | null {
	try {
		const [module] = lookupModule(withProps('HTTP')) as [
			unknown,
			number | undefined,
		]
		const http = asRecord(asRecord(module).HTTP)
		if (typeof http.get === 'function') return http as unknown as HttpLike
	} catch {}
	return null
}

// ─── Messages ────────────────────────────────────────────────────────────────

function toArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value
	const record = asRecord(value)
	const toArrayFn = record.toArray
	if (typeof toArrayFn === 'function') {
		try {
			const out = (toArrayFn as () => unknown)()
			return Array.isArray(out) ? out : []
		} catch {}
	}
	return []
}

function asMessage(value: unknown): MessageLike | null {
	const record = asRecord(value)
	if (typeof record.id !== 'string' || !record.id) return null
	const author = asRecord(record.author)
	return {
		id: record.id,
		content: typeof record.content === 'string' ? record.content : '',
		timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
		author: {
			id: typeof author.id === 'string' ? author.id : '',
			username: typeof author.username === 'string' ? author.username : '',
			globalName:
				typeof author.globalName === 'string'
					? author.globalName
					: typeof author.global_name === 'string'
						? author.global_name
						: '',
		},
		attachments: Array.isArray(record.attachments) ? record.attachments : [],
		embeds: Array.isArray(record.embeds) ? record.embeds : [],
		deleted: record.deleted === true,
		state: typeof record.state === 'string' ? record.state : undefined,
	}
}

function normalise(value: unknown): MessageLike[] {
	const record = asRecord(value)
	const list = Array.isArray(value)
		? value
		: Array.isArray(record.body)
			? record.body
			: Array.isArray(record.messages)
				? record.messages
				: toArray(value)
	const out: MessageLike[] = []
	for (const raw of list) {
		const message = asMessage(raw)
		if (message) out.push(message)
	}
	return out
}

// A snowflake carries its creation time in its high bits, so the oldest id is
// the cursor even on a build without timestamps.
function stampOf(message: MessageLike): number {
	const raw = typeof message.timestamp === 'string' ? message.timestamp : ''
	const parsed = raw ? new Date(raw).getTime() : Number.NaN
	if (!Number.isNaN(parsed)) return parsed
	const id = typeof message.id === 'string' ? message.id : ''
	return /^\d+$/.test(id) ? Number(id) / 4194304 : 0
}

function oldestId(messages: MessageLike[]): string {
	let oldest = ''
	let oldestStamp = Number.POSITIVE_INFINITY
	for (const message of messages) {
		if (typeof message.id !== 'string' || !message.id) continue
		const stamp = stampOf(message)
		if (stamp < oldestStamp) {
			oldestStamp = stamp
			oldest = message.id
		}
	}
	return oldest
}

// One page of the chat, newest first. Discord's HTTP module is the same request
// the app makes when you scroll, so it carries the session and the client's own
// rate limiter; the message action is the fallback for a build without it.
async function fetchPage(
	channelId: string,
	before: string,
): Promise<MessageLike[]> {
	const query = `limit=${PAGE_LIMIT}${before ? `&before=${before}` : ''}`
	const http = resolveHttp()
	if (http?.get) {
		try {
			const response = await http.get({
				url: `/channels/${channelId}/messages?${query}`,
			})
			const messages = normalise(response)
			if (messages.length) {
				diagnostics.history = 'Reading the chat with Discord’s HTTP module.'
				return messages
			}
		} catch (error) {
			diagnostics.history = `Discord’s HTTP module refused: ${errorMessage(error)}`
		}
	}
	try {
		const [module] = lookupModule(withProps('fetchMessages')) as [
			unknown,
			number | undefined,
		]
		const fetch = asRecord(module).fetchMessages
		if (typeof fetch !== 'function') return []
		const call = fetch as (args: unknown, limit?: number) => unknown
		const raw = await call({
			channelId,
			limit: PAGE_LIMIT,
			...(before ? { before } : {}),
		})
		const messages = normalise(raw)
		if (messages.length)
			diagnostics.history = 'Reading the chat with its fetch action.'
		return messages
	} catch {
		return []
	}
}

// ─── Deleting ────────────────────────────────────────────────────────────────

function firstSeconds(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0)
			return value
	}
	return 0
}

function rateLimitWait(error: unknown): number {
	const record = asRecord(error)
	const body = asRecord(record.body)
	const response = asRecord(record.response)
	const responseBody = asRecord(response.body)
	const headers = asRecord(record.headers)
	const seconds = firstSeconds(
		body.retry_after,
		record.retry_after,
		responseBody.retry_after,
		record.retryAfter,
		headers['retry-after'],
	)
	const limited =
		record.status === 429 ||
		response.status === 429 ||
		seconds > 0 ||
		/rate.?limit|\b429\b/i.test(errorMessage(error))
	if (!limited) return 0
	return Math.ceil(seconds > 0 ? seconds * 1000 : 5000) + WAIT_MARGIN_MS
}

function isGone(error: unknown): boolean {
	return /\b404\b|unknown message/i.test(errorMessage(error))
}

function reasonFor(error: unknown): string {
	const text = errorMessage(error).replace(/\s+/g, ' ').trim()
	if (!text) return 'Discord refused the request.'
	if (/missing permissions|forbidden|\b403\b/i.test(text))
		return 'Discord says you do not have permission to delete it.'
	return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms)
	})
}

async function removeMessage(
	channelId: string,
	messageId: string,
): Promise<void> {
	const actions = resolveActions()
	if (actions) {
		await actions.deleteMessage(channelId, messageId)
		return
	}
	const http = resolveHttp()
	const del = http?.del ?? http?.delete
	if (typeof del === 'function') {
		await del({ url: `/channels/${channelId}/messages/${messageId}` })
		return
	}
	throw new Error('this build does not expose message actions')
}

// One message, one request. A rate limit is waited out exactly once, for the
// delay Discord named, and then the action stops rather than retrying further.
async function removeWithRetry(
	channelId: string,
	messageId: string,
): Promise<void> {
	try {
		await removeMessage(channelId, messageId)
	} catch (error) {
		const wait = rateLimitWait(error)
		if (!wait) throw error
		if (wait > MAX_WAIT_MS) {
			throw new Error(
				`Discord is limiting deletes. Try again in ${Math.max(1, Math.ceil(wait / 1000))} s.`,
			)
		}
		progressText = `Waiting ${Math.max(1, Math.ceil(wait / 1000))} s for Discord’s limit…`
		await sleep(wait)
		if (disposed || stopRequested) throw new Error('stopped')
		await removeMessage(channelId, messageId)
	}
}

type ToastVariant = 'default' | 'success' | 'critical'

function notify(text: string, variant: ToastVariant): void {
	try {
		ToastActionCreators.open('message-deleter', { text, variant })
		return
	} catch {}
	try {
		ToastActionCreators.open({ key: 'message-deleter', content: text })
	} catch {}
	try {
		Alert.alert('Message Deleter', text)
	} catch {}
}

// ─── The run ─────────────────────────────────────────────────────────────────

function stopRun(): void {
	if (!running) return
	stopRequested = true
	progressText = 'Stopping after the message already being deleted…'
	notify('Stopping…', 'default')
}

async function runBulk(channel: ChannelLike): Promise<void> {
	const channelId = channelIdOf(channel)
	if (!channelId || running || disposed) return
	running = true
	stopRequested = false
	failure = ''
	stats = { deleted: 0, failed: 0, scanned: 0 }
	progressText = 'Reading the chat…'
	notify('Deleting your messages…', 'default')
	logger?.log?.('[Message Deleter] run started')
	let before = ''
	let pages = 0
	try {
		while (!stopRequested && !disposed) {
			const page = await fetchPage(channelId, before)
			if (!page.length) break
			stats.scanned += page.length
			progressText = `Read ${stats.scanned}, deleted ${stats.deleted}…`
			for (const message of page) {
				if (stopRequested || disposed) break
				if (!deletable(message)) continue
				const id = typeof message.id === 'string' ? message.id : ''
				if (!id) continue
				try {
					await removeWithRetry(channelId, id)
					stats.deleted++
				} catch (error) {
					if (isGone(error)) {
						stats.deleted++
						continue
					}
					stats.failed++
					failure = reasonFor(error)
					stopRequested = true
					break
				}
				if (stats.deleted % 10 === 0)
					notify(`${stats.deleted} deleted…`, 'default')
				if (PAUSE_MS > 0) await sleep(PAUSE_MS)
			}
			if (failure || stopRequested || disposed) break
			const oldest = oldestId(page)
			if (!oldest || oldest === before) break
			before = oldest
			pages++
			if (page.length < PAGE_LIMIT) break
			if (pages >= MAX_PAGES) {
				progressText = 'Reached the limit for one run.'
				break
			}
		}
	} catch (error) {
		failure = reasonFor(error)
	} finally {
		running = false
	}
	progressText = ''
	const done = stats.deleted
	const text = failure
		? `Deleted ${done}. Stopped: ${failure}`
		: stopRequested || disposed
			? done
				? `Stopped after ${done}.`
				: 'Stopped before anything was deleted.'
			: done === 0
				? 'You have not sent anything here that could be deleted.'
				: done === 1
					? '1 message deleted.'
					: `${done} messages deleted.`
	resultText = text
	notify(text, failure ? 'critical' : done ? 'success' : 'default')
	logger?.log?.(
		`[Message Deleter] run finished: ${done} deleted, ${stats.failed} failed`,
	)
}

async function deleteOne(
	message: MessageLike,
	channel: ChannelLike,
): Promise<void> {
	const channelId = channelIdOf(channel)
	const messageId = typeof message.id === 'string' ? message.id : ''
	if (!channelId || !messageId) return
	try {
		await removeWithRetry(channelId, messageId)
		resultText = 'Your message was deleted.'
		notify('Message deleted.', 'success')
	} catch (error) {
		if (isGone(error)) {
			resultText = 'That message was already gone.'
			notify('That message was already gone.', 'success')
			return
		}
		const reason = reasonFor(error)
		resultText = `Could not delete the message. ${reason}`
		notify(`Could not delete: ${reason}`, 'critical')
		logger?.warn?.('[Message Deleter] delete refused', error)
	}
}

// ─── Confirmation ────────────────────────────────────────────────────────────

function later(action: () => void): void {
	const timer = setTimeout(() => {
		timers.delete(timer)
		if (!disposed) action()
	}, CONFIRM_DELAY_MS)
	timers.add(timer)
}

// The system alert is the one surface every build has, so the confirmation does
// not depend on Discord's own components being present.
function askToDeleteOne(message: MessageLike, channel: ChannelLike): void {
	try {
		Alert.alert(
			'Delete this message?',
			`“${previewOf(message)}”\n\nIt is removed for everyone and cannot be undone.`,
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Delete',
					style: 'destructive',
					onPress: () => {
						void deleteOne(message, channel)
					},
				},
			],
			{ cancelable: true },
		)
	} catch {
		resultText =
			'This build could not show a confirmation, so nothing was deleted.'
	}
}

function askToDeleteAll(channel: ChannelLike): void {
	try {
		Alert.alert(
			'Delete all your messages?',
			'Every message you sent in this chat will be deleted, one at a time. They are removed for everyone and this cannot be undone.',
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Delete all',
					style: 'destructive',
					onPress: () => {
						void runBulk(channel)
					},
				},
			],
			{ cancelable: true },
		)
	} catch {
		resultText =
			'This build could not show a confirmation, so nothing was deleted.'
	}
}

// ─── The long-press menu ─────────────────────────────────────────────────────

interface ElementLike {
	type?: unknown
	props?: Record<string, unknown>
	key?: unknown
}

function asElement(value: unknown): ElementLike | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const element = value as ElementLike
	return element.props && typeof element.props === 'object' ? element : null
}

function typeName(type: unknown): string {
	if (typeof type !== 'function') return ''
	const named = type as { displayName?: string; name?: string }
	return named.displayName ?? named.name ?? ''
}

// The sheet is inside the component's output, not the output itself, so the
// element tree is walked until Discord's own ActionSheet is reached.
function findSheet(
	value: unknown,
	seen = new Set<unknown>(),
	depth = 0,
): ElementLike | null {
	if (!value || typeof value !== 'object' || depth > 32) return null
	if (seen.has(value)) return null
	seen.add(value)
	if (Array.isArray(value)) {
		for (const child of value) {
			const found = findSheet(child, seen, depth + 1)
			if (found) return found
		}
		return null
	}
	const element = asElement(value)
	if (!element) return null
	const marker = asRecord(Design).ActionSheet
	const name = typeName(element.type)
	if (
		(typeof marker === 'function' && element.type === marker) ||
		name === 'ActionSheet'
	) {
		return element
	}
	return findSheet(element.props?.children, seen, depth + 1)
}

function appendRows(tree: unknown, rows: unknown[]): boolean {
	const sheet = findSheet(tree)
	if (!sheet?.props) return false
	const children = [sheet.props.children].flat().filter(Boolean)
	sheet.props.children = [...children, ...rows]
	return true
}

function iconFor(name: string): unknown {
	try {
		return lookupGeneratedIconComponent(name)
	} catch {
		return undefined
	}
}

// The rows this plugin adds. Every part is looked up when the menu is drawn and
// a missing piece only drops that piece, so the menu itself can never break.
function menuRows(
	channel: ChannelLike,
	message?: MessageLike,
	onClose?: () => void,
): unknown[] {
	const design = asRecord(Design)
	const Row = design.ActionSheetRow as RowComponent | undefined
	if (typeof Row !== 'function') return []
	const Group = Row.Group
	const Icon = Row.Icon
	const close = (): void => {
		try {
			if (onClose) onClose()
			else ActionSheetActionCreators.hideActionSheet()
		} catch {}
	}
	const icon = (name: string): unknown => {
		if (typeof Icon !== 'function') return undefined
		const component = iconFor(name)
		return component ? <Icon IconComponent={component} /> : undefined
	}

	const rows: unknown[] = []
	if (message && mine(message)) {
		rows.push(
			<Row
				key="message-deleter-one"
				label="Delete this message"
				variant="danger"
				icon={icon('TrashIcon')}
				onPress={() => {
					close()
					later(() => askToDeleteOne(message, channel))
				}}
			/>,
		)
	}
	if (inDm(channel)) {
		rows.push(
			running ? (
				<Row
					key="message-deleter-stop"
					label={`Stop deleting (${stats.deleted} done)`}
					variant="danger"
					icon={icon('XIcon') ?? icon('TrashIcon')}
					onPress={() => {
						close()
						stopRun()
					}}
				/>
			) : (
				<Row
					key="message-deleter-all"
					label="Delete all my messages"
					variant="danger"
					icon={icon('TrashIcon')}
					onPress={() => {
						close()
						later(() => askToDeleteAll(channel))
					}}
				/>
			),
		)
	}
	if (!rows.length) return []
	if (typeof Group === 'function')
		return [<Group key="message-deleter">{rows}</Group>]
	return rows
}

// Discord's message menu. The rows are appended to the sheet the component
// returns, which is how the community Message Logger plugin does it.
function patchMessageSheet(): () => void {
	if (typeof asRecord(Design).ActionSheetRow !== 'function') {
		diagnostics.menu = 'This build has no action sheet rows.'
		return () => {}
	}
	let unpatch: (() => void) | undefined
	const unsubscribe = getModules(
		withName('LongPressMessageActionSheet'),
		exports => {
			const module = exports as { default?: unknown }
			if (typeof module.default !== 'function') {
				diagnostics.menu = 'The message menu has no render function.'
				return
			}
			unpatch = instead(module, 'default', (args, original) => {
				const tree = Reflect.apply(original, undefined, args) as unknown
				try {
					const props = asRecord(args[0]) as unknown as SheetProps
					const message = props.message
					const channel = props.channel
					if (!channel) return tree
					if (!message && !inDm(channel)) return tree
					const rows = menuRows(channel, message)
					if (!rows.length) return tree
					if (!appendRows(tree, rows)) {
						diagnostics.menu =
							'The message menu was found, but its rows could not be added.'
						return tree
					}
					diagnostics.menu = 'Ready. The rows are in the long-press menu.'
				} catch (error) {
					diagnostics.menu = `The message menu failed: ${errorMessage(error)}`
					logger?.warn?.('[Message Deleter] message menu patch failed', error)
				}
				return tree
			})
			diagnostics.menu = 'The message menu was found.'
		},
		{ returnNamespace: true },
	)
	return () => {
		unsubscribe()
		unpatch?.()
		unpatch = undefined
		diagnostics.menu = 'Waiting for the message menu to load.'
	}
}

// The chat menu: holding the conversation in the chat list offers the same run,
// which is where the desktop plugin puts it.
function patchChannelSheet(): () => void {
	const wrappers = new WeakMap<object, unknown>()
	const wrap = (Inner: (props: ChannelSheetProps) => unknown) => {
		const existing = wrappers.get(Inner as unknown as object)
		if (existing) return existing as (props: ChannelSheetProps) => unknown
		const Wrapper = (props: ChannelSheetProps): unknown => {
			const tree = Inner(props) as unknown
			try {
				const channel = props.channel
				if (channel && inDm(channel)) {
					const rows = menuRows(channel, undefined, props.onClose)
					if (rows.length) appendRows(tree, rows)
				}
			} catch (error) {
				logger?.warn?.('[Message Deleter] chat menu patch failed', error)
			}
			return tree
		}
		wrappers.set(Inner as unknown as object, Wrapper)
		return Wrapper
	}

	let unpatch: (() => void) | undefined
	const unsubscribe = getModules(
		withName('ChannelLongPressActionSheet'),
		exports => {
			const module = exports as { default?: unknown }
			if (typeof module.default !== 'function') {
				diagnostics.channelMenu = 'The chat menu has no render function.'
				return
			}
			unpatch = instead(module, 'default', (args, original) => {
				const tree = Reflect.apply(original, undefined, args) as unknown
				try {
					const element = asElement(tree)
					const Inner = element?.type
					if (typeof Inner !== 'function') return tree
					if (typeName(Inner) !== 'ChannelLongPressActionSheetConnected')
						return tree
					diagnostics.channelMenu = 'Ready. The row is in the chat menu.'
					return createElement(
						wrap(Inner as (props: ChannelSheetProps) => unknown),
						{
							...(element?.props ?? {}),
							key: element?.key,
						},
					)
				} catch (error) {
					logger?.warn?.('[Message Deleter] chat menu wrap failed', error)
					return tree
				}
			})
			diagnostics.channelMenu = 'The chat menu was found.'
		},
		{ returnNamespace: true },
	)
	return () => {
		unsubscribe()
		unpatch?.()
		unpatch = undefined
		diagnostics.channelMenu = 'Waiting for the chat menu to load.'
	}
}

// ─── Settings page ───────────────────────────────────────────────────────────

export default plugin({
	start({
		cleanup,
		logger: pluginLogger,
	}: {
		cleanup(fn: () => void): void
		logger: Logger
	}) {
		logger = pluginLogger
		disposed = false
		running = false
		stopRequested = false
		cleanup(patchMessageSheet())
		cleanup(patchChannelSheet())
		resolveActions()
		resolveHttp()
		logger?.log?.('[Message Deleter] ready')
	},
	stop() {
		disposed = true
		stopRequested = true
		running = false
		for (const timer of timers) clearTimeout(timer)
		timers.clear()
	},
	SettingsComponent() {
		const status = running ? progressText || 'Deleting…' : resultText
		return (
			<Page>
				<Intro text="Message Deleter works from the long-press menu: hold a message you sent and delete it, or hold any message in a chat and delete every message you sent there." />
				<Hero
					title={running ? 'Deleting…' : 'Nothing is running'}
					line={status}
					tone={running ? 'brand' : 'muted'}
				/>
				<Section title="How it works">
					<Row
						label="Delete one message"
						subLabel="Hold a message you sent, then choose Delete this message."
					/>
					<Row
						label="Delete all your messages"
						subLabel="Hold any message in the chat (or the chat itself in the list), then choose Delete all my messages."
					/>
					<Row
						label="One at a time"
						subLabel="A second between deletes, and Discord’s own wait is obeyed when it asks for one."
					/>
				</Section>
				<Section title="Status" description="What the last run did.">
					<Row label="Last result" subLabel={status} />
					{running ? (
						<Row
							label="Stop deleting"
							subLabel="Finishes the message already being deleted."
							danger
							onPress={stopRun}
						/>
					) : null}
				</Section>
				<Section
					title="Diagnostics"
					description="Each piece this build provides. A row that says it is missing names what cannot work."
				>
					<Row label="Message menu" subLabel={diagnostics.menu} />
					<Row label="Chat menu" subLabel={diagnostics.channelMenu} />
					<Row label="Delete action" subLabel={diagnostics.actions} />
					<Row label="Chat history" subLabel={diagnostics.history} />
				</Section>
				<Section
					title="Careful"
					description="Deleting removes a message for everyone and cannot be undone."
				>
					<Row label="Deleting cannot be undone" danger />
				</Section>
			</Page>
		)
	},
})
