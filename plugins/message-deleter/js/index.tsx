// Message Deleter, by cenotaph.
//
// One action in Discord's own message menu: hold a message you sent in a DM,
// choose "Delete message", confirm against a preview of it, and Discord is
// asked to delete that one message. There is no search, no history loading, no
// selection and no queue: one press, one confirmation, one request. A message
// that is not yours is never offered.
//
// The request goes through Discord's own message actions, so the login token
// stays inside the client and the client's rate limiter still sees the call.
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
import { Alert, ScrollView, Text } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord, errorMessage } from '../../_shared/types'
import type { DesignComponent, DesignShim, Logger } from '../../_shared/types'

// A DM and a group DM are the only places this plugin offers itself: a guild
// channel is somebody else's server, and its permissions are Discord's to
// enforce, not a plugin's to second-guess.
const DM = 1
const GROUP_DM = 3

// The sheet is already closing when the row is pressed, so the confirmation is
// shown after it has gone rather than underneath it.
const CONFIRM_DELAY_MS = 200
// Discord's retry_after is honoured as given; this only rounds up and adds a
// small margin, so the retry can never be earlier than the limit allows.
const WAIT_MARGIN_MS = 250
// Past this, waiting is worse than saying so: the action stops and reports the
// limit instead of holding a request open.
const MAX_WAIT_MS = 60000

interface UserLike {
	id?: string
}

interface MessageLike {
	id?: string
	content?: string
	author?: UserLike
	attachments?: unknown[]
	embeds?: unknown[]
	deleted?: boolean
	state?: string
}

interface ChannelLike {
	id?: string
	type?: number
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
}

type Tone = 'idle' | 'working' | 'ok' | 'error'

interface Status {
	tone: Tone
	text: string
}

interface Diagnostics {
	// The long-press menu was found and our row is being added to it.
	sheet: boolean
	// Discord's own delete action was found.
	actions: boolean
	// Why the menu is not there, when it is not.
	note: string
}

let logger: Logger | undefined
let status: Status = { tone: 'idle', text: '' }
const diagnostics: Diagnostics = {
	sheet: false,
	actions: false,
	note: '',
}
// One confirmation and one request at a time. Both are set synchronously, so a
// second tap cannot open a second alert or send a second delete.
let pending = false
let busy = false
let disposed = false
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

// What the confirmation shows: the message itself, shortened, or a plain
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

// One message, one request. A rate limit is waited out exactly once, for the
// delay Discord named, and then the action stops rather than retrying further.
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
		const api = resolveActions()
		if (!api) throw new Error('this build does not expose message actions')
		try {
			await api.deleteMessage(channelId, messageId)
		} catch (error) {
			const wait = rateLimitWait(error)
			if (!wait) throw error
			const seconds = waitSeconds(wait)
			if (wait > MAX_WAIT_MS) {
				setStatus(
					'error',
					`Discord is limiting deletes. Try again in ${seconds} s.`,
				)
				notify(`Rate limited. Try again in ${seconds} s.`, 'critical')
				return
			}
			setStatus('working', `Discord is limiting deletes. Waiting ${seconds} s.`)
			notify(`Rate limited. Waiting ${seconds} s.`, 'default')
			await sleep(wait)
			if (disposed) {
				setStatus('error', 'Stopped before the delete finished.')
				return
			}
			await api.deleteMessage(channelId, messageId)
		}
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

function askToDelete(message: MessageLike, channel: ChannelLike): void {
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
		askToDelete(message, channel)
	}, CONFIRM_DELAY_MS)
	timers.add(timer)
}

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

function appendRow(
	tree: unknown,
	row: unknown,
	marker: DesignComponent,
): boolean {
	const sheet = findActionSheet(tree, marker)
	if (!sheet?.props) return false
	const children = [sheet.props.children].flat().filter(Boolean)
	sheet.props.children = [...children, row]
	return true
}

function iconFor(name: string): unknown {
	try {
		return lookupGeneratedIconComponent(name)
	} catch {
		return undefined
	}
}

// Adds one row to Discord's long-press menu, and only while that menu is open
// on a message this account may delete. Every part is looked up at render time
// and every failure returns the original tree, so the menu cannot break.
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
					if (!message || !channel || !eligible(message, channel)) return tree
					const row = (
						<Group>
							<Row
								label="Delete message"
								variant="danger"
								icon={
									trashIcon ? <RowIcon IconComponent={trashIcon} /> : undefined
								}
								onPress={() => requestDelete(message, channel)}
							/>
						</Group>
					)
					if (!appendRow(tree, row, Sheet)) {
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
		cleanup(patchSheet())
		resolveActions()
		logger?.log?.('[Message Deleter] ready')
	},
	stop() {
		disposed = true
		for (const timer of timers) clearTimeout(timer)
		timers.clear()
		pending = false
		busy = false
	},
	SettingsComponent() {
		const design = (Design ?? {}) as DesignShim
		const Group = design.TableRowGroup
		const Row = design.TableRow
		const muted = token('TEXT_MUTED')
		const normal = token('TEXT_NORMAL')
		const danger = token('TEXT_DANGER')
		const statusText = status.text || 'Nothing deleted yet.'
		const menuText = diagnostics.sheet
			? 'Ready. The action is in the long-press menu.'
			: diagnostics.note || 'Waiting for the message menu to load.'

		if (typeof Group !== 'function' || typeof Row !== 'function') {
			return (
				<ScrollView style={settingsScroll}>
					<Text style={{ color: normal }}>
						Message Deleter needs the settings rows this build does not have.
					</Text>
					<Text style={{ color: muted, marginTop: 8 }}>{statusText}</Text>
				</ScrollView>
			)
		}

		return (
			<ScrollView style={settingsScroll}>
				<Group title="Message Deleter">
					<Row
						label="Delete a message"
						subLabel="Hold a message you sent in a DM, then choose Delete message."
					/>
					<Row label="Last result" subLabel={statusText} />
					<Row label="Message menu" subLabel={menuText} />
				</Group>
				<Text style={{ color: muted }}>
					Only your own messages in DMs are offered, one at a time. Deleting
					uses Discord's own delete action; nothing is scraped, queued, or
					cleaned up in the background.
				</Text>
				<Text style={{ color: danger, marginTop: 8 }}>
					Deleting cannot be undone.
				</Text>
			</ScrollView>
		)
	},
})
