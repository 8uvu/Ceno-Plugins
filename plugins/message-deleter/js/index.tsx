// Message Deleter, by cenotaph.
//
// Two ways to delete, both through Discord's own message actions:
//
//   * hold one message you sent in a DM and delete that one message;
//   * hold a message and open the chat's message list, tick what should go and
//     delete the selection, one request at a time.
//
// The list is built from what Discord's own client already holds for the chat
// (or its own fetch action when the build has one). No private endpoint, no
// copied token, and every delete goes through the client's own rate limiter:
// a 429 is waited out once for the delay Discord names, never worked around.
import {
	ActionSheetActionCreators,
	AlertActionCreators,
	ToastActionCreators,
} from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withName, withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { useEffect, useState } from 'react'
import { Alert, ScrollView, Text } from 'react-native'
import { readableText, settingsScroll, token } from '../../_shared/theme'
import { asRecord, errorMessage } from '../../_shared/types'
import type { DesignComponent, DesignShim, Logger } from '../../_shared/types'

// A DM and a group DM are the only places this plugin offers itself: a guild
// channel is somebody else's server, and its permissions are Discord's to
// enforce, not a plugin's to second-guess.
const DM = 1
const GROUP_DM = 3

// The sheet is already closing when a row is pressed, so the next surface is
// shown after it has gone rather than underneath it.
const CONFIRM_DELAY_MS = 200
// Discord's retry_after is honoured as given; this only rounds up and adds a
// small margin, so a retry can never be earlier than the limit allows.
const WAIT_MARGIN_MS = 250
// Past this, waiting is worse than saying so: the run stops and reports the
// limit instead of holding a request open.
const MAX_WAIT_MS = 60000
// One page of history per open. The list is a picker, not an archive.
const PAGE_LIMIT = 50

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
	recipients?: unknown[]
	rawRecipients?: unknown[]
}

interface SheetProps {
	message?: MessageLike
	channel?: ChannelLike
}

type SheetComponent = (props: SheetProps) => unknown

interface SheetModule {
	default?: SheetComponent
}

interface RowComponent {
	(props: Record<string, unknown>): unknown
	Group?: DesignComponent
	Icon?: DesignComponent
}

interface DesignLike {
	ActionSheet?: DesignComponent
	ActionSheetRow?: RowComponent
}

interface MessageActionsLike {
	deleteMessage(channelId: string, messageId: string): unknown
	fetchMessages?: (args: unknown, limit?: number) => unknown
}

type Tone = 'idle' | 'working' | 'ok' | 'error'

interface Status {
	tone: Tone
	text: string
}

interface Diagnostics {
	// The long-press menu was found and our rows are being added to it.
	sheet: boolean
	// Discord's own delete action was found.
	actions: boolean
	// Which module the message list came from, and how it went.
	history: string
	// Why something is missing, when it is.
	note: string
}

interface SheetState {
	channel: ChannelLike
	anchor?: MessageLike
}

let logger: Logger | undefined
let status: Status = { tone: 'idle', text: '' }
const diagnostics: Diagnostics = {
	sheet: false,
	actions: false,
	history: '',
	note: '',
}
// One confirmation and one request at a time. Both are set synchronously, so a
// second tap cannot open a second alert or send a second delete.
let pending = false
let busy = false
let disposed = false
// A bulk run is guarded separately: it outlives the sheet that started it.
let batchRunning = false
let batchCancelled = false
let sheetState: SheetState | null = null
const timers = new Set<ReturnType<typeof setTimeout>>()

function setStatus(tone: Tone, text: string): void {
	status = { tone, text }
}

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

// Discord allows an account to delete its own message in a DM. Everything else
// is refused here rather than at the server, so the action never appears where
// it could not work.
function eligible(message?: MessageLike, channel?: ChannelLike): boolean {
	if (!message || typeof message.id !== 'string' || !message.id) return false
	if (!channel || typeof channel.id !== 'string' || !channel.id) return false
	if (channel.type !== DM && channel.type !== GROUP_DM) return false
	if (message.deleted === true) return false
	if (message.state === 'SENDING' || message.state === 'FAILED') return false
	const me = currentUserId()
	if (!me) return false
	return typeof message.author?.id === 'string' && message.author.id === me
}

function mine(message?: MessageLike): boolean {
	const me = currentUserId()
	if (!me || !message) return false
	return typeof message.author?.id === 'string' && message.author.id === me
}

// The list only offers what Discord will actually let this account delete: its
// own messages, still there, and not one that is still sending. Anything else
// would be a row that could only fail.
function ownMessages(messages: MessageLike[]): MessageLike[] {
	return messages.filter(
		message =>
			mine(message) &&
			message.deleted !== true &&
			message.state !== 'SENDING' &&
			message.state !== 'FAILED',
	)
}

// What a row or a confirmation shows: the message itself, shortened, or a plain
// description when it has no text.
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

function timeOf(message: MessageLike): string {
	const raw = typeof message.timestamp === 'string' ? message.timestamp : ''
	if (!raw) return ''
	const date = new Date(raw)
	if (Number.isNaN(date.getTime())) return ''
	const hours = String(date.getHours()).padStart(2, '0')
	const minutes = String(date.getMinutes()).padStart(2, '0')
	return `${hours}:${minutes}`
}

function authorOf(message: MessageLike): string {
	const author = message.author
	if (!author) return 'Unknown'
	if (mine(message)) return 'You'
	const named =
		typeof author.globalName === 'string'
			? author.globalName
			: typeof author.global_name === 'string'
				? author.global_name
				: ''
	if (named) return named
	return typeof author.username === 'string' && author.username
		? author.username
		: 'Unknown'
}

function resolveActions(): MessageActionsLike | null {
	try {
		const [module] = lookupModule(
			withProps('deleteMessage', 'sendMessage'),
		) as [unknown, number | undefined]
		const record = asRecord(module)
		if (typeof record.deleteMessage === 'function') {
			diagnostics.actions = true
			return module as unknown as MessageActionsLike
		}
	} catch {}
	return null
}

function firstSeconds(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0)
			return value
	}
	return 0
}

// How long Discord asked us to wait, in milliseconds, or 0 when the error was
// not a rate limit.
function rateLimitWait(error: unknown): number {
	const record = asRecord(error)
	const body = asRecord(record.body)
	const response = asRecord(record.response)
	const responseBody = asRecord(response.body)
	const seconds = firstSeconds(
		body.retry_after,
		record.retry_after,
		responseBody.retry_after,
		record.retryAfter,
	)
	const limited =
		record.status === 429 ||
		response.status === 429 ||
		seconds > 0 ||
		/rate.?limit|\b429\b/i.test(errorMessage(error))
	if (!limited) return 0
	return Math.ceil(seconds > 0 ? seconds * 1000 : 5000) + WAIT_MARGIN_MS
}

// The seconds shown to the user are Discord's own number, not the padded wait.
function waitSeconds(ms: number): number {
	return Math.max(1, Math.ceil((ms - WAIT_MARGIN_MS) / 1000))
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

type ToastVariant = 'default' | 'success' | 'critical'

// A toast is the smallest status the host offers; if this build has none, a
// plain alert says the same thing.
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

// ─── Discord's own delete action ─────────────────────────────────────────────

// One message, one request. A rate limit is waited out exactly once, for the
// delay Discord named, and then the action stops rather than retrying further.
async function deleteWithRetry(
	channelId: string,
	messageId: string,
): Promise<void> {
	const api = resolveActions()
	if (!api) throw new Error('this build does not expose message actions')
	try {
		await api.deleteMessage(channelId, messageId)
	} catch (error) {
		const wait = rateLimitWait(error)
		if (!wait) throw error
		if (wait > MAX_WAIT_MS) {
			const seconds = waitSeconds(wait)
			throw new Error(`Discord is limiting deletes. Try again in ${seconds} s.`)
		}
		await sleep(wait)
		if (disposed) throw new Error('the plugin was stopped')
		await api.deleteMessage(channelId, messageId)
	}
}

// ─── The chat's messages ─────────────────────────────────────────────────────

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
	const message: MessageLike = {
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
	return message
}

function normalise(value: unknown): MessageLike[] {
	const out: MessageLike[] = []
	for (const raw of toArray(value)) {
		const message = asMessage(raw)
		if (message) out.push(message)
	}
	return out
}

// What the client already holds for the chat. No network call, so the list
// appears instantly and works offline.
function loadedMessages(channelId: string): MessageLike[] {
	try {
		const [module] = lookupModule(withProps('getMessages')) as [
			unknown,
			unknown,
		]
		const getMessages = asRecord(module).getMessages
		if (typeof getMessages === 'function') {
			const messages = normalise(
				(getMessages as (id: string) => unknown)(channelId),
			)
			if (messages.length) diagnostics.history = 'cached messages'
			return messages
		}
	} catch {}
	return []
}

// Discord's own fetch action, when the build has one. It goes through the
// client's auth and rate limiter, exactly like scrolling the chat.
async function fetchMessages(channelId: string): Promise<MessageLike[]> {
	try {
		const [module] = lookupModule(withProps('fetchMessages')) as [
			unknown,
			unknown,
		]
		const fetch = asRecord(module).fetchMessages
		if (typeof fetch !== 'function') return []
		const call = fetch as (args: unknown, limit?: number) => unknown
		let raw: unknown
		try {
			raw = await call({ channelId, limit: PAGE_LIMIT })
		} catch {
			raw = await call(channelId, PAGE_LIMIT)
		}
		const messages = normalise(raw)
		if (messages.length) diagnostics.history = 'fetchMessages'
		return messages
	} catch {
		return []
	}
}

// ─── Deleting a selection ────────────────────────────────────────────────────

interface BatchHooks {
	onProgress(text: string): void
	onDone(text: string, deleted: number, failed: boolean): void
}

function cancelBatch(): void {
	batchCancelled = true
}

// Sequential on purpose: one request at a time, so the client's rate limiter
// sees each delete, and a limit stops the run instead of hammering it.
async function deleteBatch(
	channelId: string,
	ids: string[],
	hooks: BatchHooks,
): Promise<void> {
	if (batchRunning || ids.length === 0) return
	batchRunning = true
	batchCancelled = false
	let deleted = 0
	let failure = ''
	try {
		for (let index = 0; index < ids.length; index++) {
			if (batchCancelled || disposed) break
			hooks.onProgress(`Deleting ${index + 1} of ${ids.length}…`)
			try {
				await deleteWithRetry(channelId, ids[index])
				deleted++
			} catch (error) {
				if (isGone(error)) {
					deleted++
					continue
				}
				failure = reasonFor(error)
				break
			}
		}
	} finally {
		batchRunning = false
	}

	const left = ids.length - deleted
	const stopped = batchCancelled
	if (failure) {
		setStatus('error', `Deleted ${deleted} of ${ids.length}. ${failure}`)
		notify(`Deleted ${deleted} of ${ids.length}. ${failure}`, 'critical')
	} else if (stopped && left > 0) {
		setStatus('idle', `Stopped after ${deleted} of ${ids.length}.`)
		notify(`Stopped after ${deleted}.`, 'default')
	} else if (deleted === 1) {
		setStatus('ok', 'One message deleted.')
		notify('Message deleted.', 'success')
	} else {
		setStatus('ok', `${deleted} messages deleted.`)
		notify(`${deleted} messages deleted.`, 'success')
	}
	logger?.log?.(`[Message Deleter] bulk run: ${deleted}/${ids.length}`)
	hooks.onDone(
		failure
			? `Deleted ${deleted} of ${ids.length}. ${failure}`
			: stopped && left > 0
				? `Stopped after ${deleted} of ${ids.length}.`
				: `${deleted} deleted.`,
		deleted,
		Boolean(failure),
	)
}

// ─── Confirmation ────────────────────────────────────────────────────────────

function askToDeleteOne(message: MessageLike, channel: ChannelLike): void {
	const body = `“${previewOf(message)}”\n\nDeleting removes it for everyone and cannot be undone.`
	try {
		Alert.alert(
			'Delete this message?',
			body,
			[
				{
					text: 'Cancel',
					style: 'cancel',
					onPress: () => {
						pending = false
					},
				},
				{
					text: 'Delete',
					style: 'destructive',
					onPress: () => {
						pending = false
						void deleteOne(message, channel)
					},
				},
			],
			{
				cancelable: true,
				onDismiss: () => {
					pending = false
				},
			},
		)
	} catch {
		pending = false
		setStatus(
			'error',
			'This build could not show a confirmation, so nothing was deleted.',
		)
	}
}

// Discord's own alert, so the confirmation looks like the rest of the client.
// Builds without it fall back to the system alert.
function askToDeleteMany(count: number, run: () => void): void {
	const design = (Design ?? {}) as DesignShim
	const Modal = design.AlertModal
	const Action = design.AlertActionButton
	const title =
		count === 1 ? 'Delete this message?' : `Delete ${count} messages?`
	const content = 'They are removed for everyone and this cannot be undone.'
	if (typeof Modal === 'function' && typeof Action === 'function') {
		try {
			AlertActionCreators.openAlert(
				'message-deleter-bulk',
				<Modal
					title={title}
					content={content}
					actions={
						<Action
							text="Delete"
							variant="danger"
							onPress={() => {
								run()
							}}
						/>
					}
				/>,
			)
			return
		} catch {}
	}
	try {
		Alert.alert(title, content, [
			{ text: 'Cancel', style: 'cancel' },
			{ text: 'Delete', style: 'destructive', onPress: run },
		])
	} catch {}
}

async function deleteOne(
	message: MessageLike,
	channel: ChannelLike,
): Promise<void> {
	const channelId = typeof channel.id === 'string' ? channel.id : ''
	const messageId = typeof message.id === 'string' ? message.id : ''
	if (!channelId || !messageId || busy) return
	busy = true
	setStatus('working', 'Deleting the message…')
	try {
		await deleteWithRetry(channelId, messageId)
		setStatus('ok', 'Your message was deleted.')
		notify('Message deleted.', 'success')
		logger?.log?.('[Message Deleter] one message deleted')
	} catch (error) {
		if (isGone(error)) {
			setStatus('ok', 'That message was already gone.')
			notify('That message was already gone.', 'success')
			return
		}
		const reason = reasonFor(error)
		setStatus('error', `Could not delete the message. ${reason}`)
		notify(`Could not delete: ${reason}`, 'critical')
		logger?.warn?.('[Message Deleter] delete refused', error)
	} finally {
		busy = false
	}
}

function requestDelete(message: MessageLike, channel: ChannelLike): void {
	if (pending || busy) return
	pending = true
	try {
		ActionSheetActionCreators.hideActionSheet()
	} catch {}
	const timer = setTimeout(() => {
		timers.delete(timer)
		if (disposed) {
			pending = false
			return
		}
		askToDeleteOne(message, channel)
	}, CONFIRM_DELAY_MS)
	timers.add(timer)
}

// ─── The message list ────────────────────────────────────────────────────────

interface BulkSheetProps {
	design: DesignShim
}

// The Discrub layout, drawn with Discord's own rows: one row per message with a
// checkbox, a select-all switch, a live count, and a red delete row. It only
// ever offers the account's own messages, because Discord will not let it
// delete anybody else's in a DM.
function BulkSheet({ design }: BulkSheetProps): unknown {
	const Group = design.TableRowGroup
	const Row = design.TableRow
	const SwitchRow = design.TableSwitchRow
	const CheckRow = design.TableCheckboxRow
	const channelId =
		typeof sheetState?.channel.id === 'string' ? sheetState.channel.id : ''

	const cached = (() => {
		try {
			return ownMessages(loadedMessages(channelId))
		} catch {
			return []
		}
	})()

	const [messages, setMessages] = useState(cached) as [
		MessageLike[],
		(next: MessageLike[] | ((prev: MessageLike[]) => MessageLike[])) => void,
	]
	const [selected, setSelected] = useState({}) as [
		Record<string, boolean>,
		(
			next:
				| Record<string, boolean>
				| ((prev: Record<string, boolean>) => Record<string, boolean>),
		) => void,
	]
	const [note, setNote] = useState(
		cached.length ? '' : 'Reading this chat…',
	) as [string, (next: string | ((prev: string) => string)) => void]
	const [progress, setProgress] = useState('') as [
		string,
		(next: string | ((prev: string) => string)) => void,
	]

	useEffect(() => {
		if (cached.length || !channelId) return
		let live = true
		void (async () => {
			const all = await fetchMessages(channelId)
			if (!live) return
			const fetched = ownMessages(all)
			if (fetched.length) {
				setMessages(fetched)
				setNote('')
			} else if (all.length) {
				setNote('You have not sent anything in this chat yet.')
			} else {
				setNote(
					'This build does not expose the chat’s messages. Scroll the chat and try again.',
				)
			}
		})()
		return () => {
			live = false
		}
	}, [])

	const count = messages.length
	const chosen = messages.filter(message => selected[message.id ?? ''])
	const allChosen = count > 0 && chosen.length === count
	const running = batchRunning

	const toggle = (id: string): void => {
		setSelected(previous => {
			const next = { ...previous }
			if (next[id]) delete next[id]
			else next[id] = true
			return next
		})
	}

	const chooseAll = (value: boolean): void => {
		if (!value) {
			setSelected({})
			return
		}
		const next: Record<string, boolean> = {}
		for (const message of messages) {
			if (message.id) next[message.id] = true
		}
		setSelected(next)
	}

	const run = (): void => {
		if (running || chosen.length === 0) return
		const ids = chosen
			.map(message => (typeof message.id === 'string' ? message.id : ''))
			.filter(Boolean)
		askToDeleteMany(ids.length, () => {
			void deleteBatch(channelId, ids, {
				onProgress: text => {
					setProgress(text)
				},
				onDone: text => {
					setProgress('')
					setNote(text)
					setSelected({})
				},
			})
		})
	}

	const stop = (): void => {
		cancelBatch()
		setProgress('')
	}

	const summary =
		count === 0
			? note || 'No messages from you in this chat.'
			: `${chosen.length} of ${count} selected`

	if (typeof Group !== 'function' || typeof Row !== 'function') {
		return (
			<ScrollView style={settingsScroll}>
				<BodyText text="This build does not expose the rows the message list needs." />
			</ScrollView>
		)
	}

	return (
		<ScrollView style={settingsScroll}>
			<Group
				title="Delete messages"
				description="Only the messages you sent are listed, and deleting cannot be undone."
			>
				{SwitchRow ? (
					<SwitchRow
						label="Select all"
						subLabel={`${count} message${count === 1 ? '' : 's'} listed`}
						value={allChosen}
						onValueChange={chooseAll}
					/>
				) : null}
				{count === 0 ? (
					<Row label="Nothing of yours listed" subLabel={summary} />
				) : (
					messages.map(message => {
						const id = message.id ?? ''
						const label = `${authorOf(message)} · ${timeOf(message) || 'no time'}`
						if (CheckRow) {
							return (
								<CheckRow
									key={id}
									value={id}
									label={label}
									subLabel={previewOf(message)}
									checked={selected[id] === true}
									onPress={() => toggle(id)}
								/>
							)
						}
						return (
							<Row
								key={id}
								label={label}
								subLabel={previewOf(message)}
								arrow={false}
								onPress={() => toggle(id)}
							/>
						)
					})
				)}
			</Group>
			<Group title={progress || summary}>
				<Row
					label={
						running
							? 'Deleting…'
							: chosen.length === 1
								? 'Delete 1 message'
								: `Delete ${chosen.length} messages`
					}
					subLabel={
						running
							? 'One request at a time, within Discord’s limits.'
							: 'Asks for a confirmation first.'
					}
					variant="danger"
					disabled={running || chosen.length === 0}
					onPress={run}
				/>
				<Row
					label={running ? 'Stop deleting' : 'Close'}
					subLabel={
						running ? 'Finishes the message already being deleted.' : undefined
					}
					onPress={() => {
						if (running) stop()
						try {
							ActionSheetActionCreators.hideActionSheet()
						} catch {}
					}}
				/>
			</Group>
		</ScrollView>
	)
}

// Discord's sheet action takes the component to show, and its own builds have
// taken it two ways: a promise of the module, or a function that returns one.
// This is both, so the list opens on either without guessing the build first.
const SHEET_KEY = 'message-deleter-list'

interface LazySheetModule {
	default: () => unknown
}

// Returns why the sheet did not open, or an empty string when it did. Discord's
// action has taken the component three ways across builds, so each is tried in
// turn: the promise of the module (what the docs describe), a function that
// returns it, and the key first. Whichever the build wants, it is the first one
// that does not throw.
function openSheet(Sheet: () => unknown): string {
	const creators = ActionSheetActionCreators as unknown as {
		openLazy?: unknown
	}
	const open = creators?.openLazy
	if (typeof open !== 'function') return 'this build cannot open a sheet'
	const call = open as (first: unknown, second: unknown) => void
	const load = (): Promise<LazySheetModule> =>
		Promise.resolve({ default: Sheet })
	const attempts: Array<() => void> = [
		() => call(load(), SHEET_KEY),
		() => call(load, SHEET_KEY),
		() => call(SHEET_KEY, load),
	]
	let first: unknown
	for (const attempt of attempts) {
		try {
			attempt()
			return ''
		} catch (error) {
			if (first === undefined) first = error
		}
	}
	return errorMessage(first) || 'the sheet action refused'
}

function openBulkSheet(channel: ChannelLike, anchor: MessageLike): void {
	if (!channel || typeof channel.id !== 'string') return
	sheetState = { channel, anchor }
	try {
		ActionSheetActionCreators.hideActionSheet()
	} catch {}
	const timer = setTimeout(() => {
		timers.delete(timer)
		if (disposed) return
		const design = (Design ?? {}) as DesignShim
		if (
			typeof design.TableRowGroup !== 'function' ||
			typeof design.TableRow !== 'function'
		) {
			diagnostics.note = 'this build does not expose the rows the list needs'
			notify('This build cannot show the message list.', 'critical')
			return
		}
		try {
			const Sheet = (): unknown => <BulkSheet design={design} />
			const problem = openSheet(Sheet)
			if (problem) {
				diagnostics.note = `the message list could not open: ${problem}`
				logger?.warn?.('[Message Deleter] list failed', problem)
				notify(`The message list could not open: ${problem}`, 'critical')
			}
		} catch (error) {
			diagnostics.note = `the message list could not open: ${errorMessage(error)}`
			logger?.warn?.('[Message Deleter] list failed', error)
			notify(
				`The message list could not open: ${errorMessage(error)}`,
				'critical',
			)
		}
	}, CONFIRM_DELAY_MS)
	timers.add(timer)
}

// ─── The long-press menu ─────────────────────────────────────────────────────

interface ElementLike {
	type?: unknown
	props?: Record<string, unknown>
}

function asElement(value: unknown): ElementLike | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const element = value as ElementLike
	return element.props && typeof element.props === 'object' ? element : null
}

// The sheet is inside the component's output, not the output itself, so the
// element tree is walked until Discord's own ActionSheet is reached.
function findActionSheet(
	value: unknown,
	marker: DesignComponent,
	seen = new Set<unknown>(),
	depth = 0,
): ElementLike | null {
	if (!value || typeof value !== 'object' || depth > 24) return null
	if (seen.has(value)) return null
	seen.add(value)
	if (Array.isArray(value)) {
		for (const child of value) {
			const found = findActionSheet(child, marker, seen, depth + 1)
			if (found) return found
		}
		return null
	}
	const element = asElement(value)
	if (!element) return null
	if (element.type === marker) return element
	return findActionSheet(element.props?.children, marker, seen, depth + 1)
}

function appendRows(
	tree: unknown,
	rows: unknown[],
	marker: DesignComponent,
): boolean {
	const sheet = findActionSheet(tree, marker)
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

// Adds the rows to Discord's long-press menu, and only while that menu is open
// on a DM. Every part is looked up at render time and every failure returns the
// original tree, so the menu cannot break.
function patchSheet(): () => void {
	const design = (Design ?? {}) as DesignLike
	const Sheet = design.ActionSheet
	const Row = design.ActionSheetRow
	const Group = Row?.Group
	const RowIcon = Row?.Icon
	if (
		typeof Sheet !== 'function' ||
		typeof Row !== 'function' ||
		typeof Group !== 'function' ||
		typeof RowIcon !== 'function'
	) {
		diagnostics.note = 'this build does not expose action sheet rows'
		return () => {}
	}
	const trashIcon = iconFor('TrashIcon')
	const listIcon = iconFor('ListIcon') ?? trashIcon
	let unpatch: (() => void) | undefined

	const unsubscribe = getModules(
		withName('LongPressMessageActionSheet'),
		exports => {
			const module = exports as SheetModule
			if (typeof module.default !== 'function') {
				diagnostics.note = 'the message menu has no render function'
				return
			}
			unpatch = instead(module, 'default', (args, original) => {
				const tree = Reflect.apply(original, undefined, args) as unknown
				try {
					const props = asRecord(args[0]) as unknown as SheetProps
					const message = props.message
					const channel = props.channel
					if (!message || !channel) return tree
					const isMine = eligible(message, channel)
					const inDm = channel.type === DM || channel.type === GROUP_DM
					if (!isMine && !inDm) return tree
					const rows: unknown[] = []
					if (isMine) {
						rows.push(
							<Group key="message-deleter-one">
								<Row
									label="Delete message"
									variant="danger"
									icon={
										trashIcon ? (
											<RowIcon IconComponent={trashIcon} />
										) : undefined
									}
									onPress={() => requestDelete(message, channel)}
								/>
							</Group>,
						)
					}
					if (inDm) {
						rows.push(
							<Group key="message-deleter-many">
								<Row
									label="Delete messages in this chat…"
									icon={
										listIcon ? <RowIcon IconComponent={listIcon} /> : undefined
									}
									onPress={() => openBulkSheet(channel, message)}
								/>
							</Group>,
						)
					}
					if (!appendRows(tree, rows, Sheet)) {
						diagnostics.note = 'the message menu could not be extended'
						return tree
					}
					diagnostics.sheet = true
					diagnostics.note = ''
				} catch (error) {
					diagnostics.note = `the message menu could not be extended: ${errorMessage(error)}`
					logger?.warn?.('[Message Deleter] menu patch failed', error)
				}
				return tree
			})
			diagnostics.sheet = true
		},
		{ returnNamespace: true },
	)

	return () => {
		unsubscribe()
		unpatch?.()
		unpatch = undefined
		diagnostics.sheet = false
	}
}

// ─── Settings page ───────────────────────────────────────────────────────────

// Body copy is drawn by Discord whenever it can be: the client owns the colour
// and the type scale, so it reads on every theme. Only a build without the
// design system falls back to React Native text, and that path always sets an
// explicit colour — uncoloured text is black, which is invisible on dark.
function BodyText({ text }: { text: string }): unknown {
	const design = (Design ?? {}) as DesignShim
	const DText = design.Text
	if (typeof DText === 'function') {
		return <DText variant="text-sm/medium">{text}</DText>
	}
	return (
		<Text style={{ color: readableText(), fontSize: 15, lineHeight: 21 }}>
			{text}
		</Text>
	)
}

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
		batchRunning = false
		batchCancelled = false
		cleanup(patchSheet())
		resolveActions()
		logger?.log?.('[Message Deleter] ready')
	},
	stop() {
		disposed = true
		cancelBatch()
		for (const timer of timers) clearTimeout(timer)
		timers.clear()
		pending = false
		busy = false
		sheetState = null
	},
	SettingsComponent() {
		const design = (Design ?? {}) as DesignShim
		const Group = design.TableRowGroup
		const Row = design.TableRow
		const danger = token('TEXT_DANGER')
		const result = status.text || 'Nothing deleted yet.'
		const menu = diagnostics.sheet
			? 'Ready. The rows are in the long-press menu.'
			: diagnostics.note || 'Waiting for the message menu to load.'
		const list = diagnostics.history
			? `Reading messages with ${diagnostics.history}.`
			: 'Not read yet. Open the list in a chat to find out.'
		const action = diagnostics.actions
			? 'Discord’s own delete action was found.'
			: 'Not found yet.'

		if (typeof Group === 'function' && typeof Row === 'function') {
			return (
				<ScrollView style={settingsScroll}>
					<Group
						title="Message Deleter"
						description="Delete your own messages in a DM, one at a time or from the chat’s list."
					>
						<Row
							label="Delete one message"
							subLabel="Hold a message you sent, then choose Delete message."
						/>
						<Row
							label="Delete several"
							subLabel="Hold any message, then choose Delete messages in this chat…"
						/>
						<Row
							label="Nothing runs on its own"
							subLabel="No background cleanup and no queue: only what you confirm."
						/>
					</Group>
					<Group title="Last result">
						<Row label="Status" subLabel={result} />
					</Group>
					<Group title="Diagnostics">
						<Row label="Message menu" subLabel={menu} />
						<Row label="Delete action" subLabel={action} />
						<Row label="Message list" subLabel={list} />
					</Group>
					<Group
						title="Careful"
						description="Deleting removes a message for everyone and cannot be undone."
					>
						<Row label="Deleting cannot be undone" variant="danger" />
					</Group>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<BodyText text="Message Deleter" />
				<BodyText text="Hold a message you sent in a DM, then choose Delete message. Hold any message and choose Delete messages in this chat to pick several." />
				<BodyText text={result} />
				<BodyText text={menu} />
				<BodyText text={action} />
				<BodyText text={list} />
				<Text
					style={{
						color: danger ?? readableText(),
						fontSize: 15,
						lineHeight: 21,
					}}
				>
					Deleting cannot be undone.
				</Text>
			</ScrollView>
		)
	},
})
