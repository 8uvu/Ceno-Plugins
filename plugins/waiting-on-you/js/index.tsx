// Waiting on You, by cenotaph. A local list of the conversations whose last
// message is theirs: the ones you meant to answer and did not.
//
// A chat leaves the list the moment you send anything in it, and nothing is
// uploaded. It only knows what it saw while the plugin was running, so a chat
// whose last message arrived earlier is not listed until something new happens
// there; the page says that instead of guessing.
import { onFluxEventDispatched } from '@valenced/discord/flux'
import {
	ago,
	clip,
	plural,
	selfId,
	storeNamed,
	userName,
} from '../../_shared/lib/format'
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
import { asRecord } from '../../_shared/types'
import type { JsonStorage, Logger } from '../../_shared/types'

interface Chat {
	name: string
	// When their message arrived, as Discord stamped it.
	at: number
	preview: string
}

interface Settings {
	enabled: boolean
	groups: boolean
	chats: Record<string, Chat>
}

const DEFAULTS: Settings = { enabled: true, groups: false, chats: {} }

// A ceiling, so a long-running install cannot grow the storage file forever.
const MAX_CHATS = 100
const PREVIEW = 90
const DM = 1
const GROUP_DM = 3

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

function chatsOf(settings: Settings): Record<string, Chat> {
	const chats = settings.chats
	return chats && typeof chats === 'object' ? chats : {}
}

function bodyOf(message: Record<string, unknown>): string {
	const text = clip(
		typeof message.content === 'string' ? message.content : '',
		PREVIEW,
	)
	if (text) return text
	const files = Array.isArray(message.attachments) ? message.attachments.length : 0
	if (files === 1) return '(an attachment)'
	if (files > 1) return `(${files} attachments)`
	return '(no text)'
}

function stampOf(message: Record<string, unknown>): number {
	const raw = typeof message.timestamp === 'string' ? message.timestamp : ''
	const parsed = raw ? Date.parse(raw) : Number.NaN
	const now = Date.now()
	if (Number.isNaN(parsed) || parsed > now) return now
	return parsed
}

function nameOf(
	channel: Record<string, unknown>,
	author: Record<string, unknown>,
	channelId: string,
): string {
	if (typeof channel.name === 'string' && channel.name) return '#' + channel.name
	const recipients = Array.isArray(channel.recipients) ? channel.recipients : []
	const other = recipients[0]
	if (other && typeof other === 'object') {
		const person = other as Record<string, unknown>
		const name = person.globalName ?? person.username
		if (typeof name === 'string' && name) return name
	}
	const authorName = author.globalName ?? author.global_name ?? author.username
	if (typeof authorName === 'string' && authorName) return authorName
	if (typeof author.id === 'string') return userName(author.id)
	return channelId
}

function see(payload: unknown): void {
	const settings = current()
	// Tracking is on by default, so only an explicit off stops it.
	if (settings.enabled === false) return
	const message = asRecord(asRecord(payload).message)
	const channelId = message.channel_id == null ? '' : String(message.channel_id)
	if (!channelId) return
	let channel: Record<string, unknown> = {}
	try {
		const lookup = storeNamed('ChannelStore')?.getChannel
		if (typeof lookup === 'function') {
			channel = asRecord((lookup as (id: string) => unknown)(channelId))
		}
	} catch {}
	const type = typeof channel.type === 'number' ? channel.type : -1
	if (type !== DM && !(type === GROUP_DM && settings.groups === true)) return
	const chats = chatsOf(settings)
	const author = asRecord(message.author)
	const me = selfId()
	if (me && author.id === me) {
		// You answered: the chat is off the list.
		if (!chats[channelId]) return
		const next = { ...chats }
		delete next[channelId]
		write({ chats: next })
		return
	}
	if (!author.id) return
	const chat: Chat = {
		name: nameOf(channel, author, channelId),
		at: stampOf(message),
		preview: bodyOf(message),
	}
	const entries = Object.entries({ ...chats, [channelId]: chat })
		.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
		.slice(0, MAX_CHATS)
	write({ chats: Object.fromEntries(entries) })
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		cleanup(
			onFluxEventDispatched('MESSAGE_CREATE', (payload: unknown) => {
				try {
					see(payload)
				} catch (error) {
					logger?.warn?.('[Waiting on You] skipped a message', error)
				}
				return payload
			}),
		)
		logger?.log?.('[Waiting on You] started')
	},
	stop() {
		live = null
	},
	SettingsComponent({
		api,
	}: {
		api: { jsonStorage: JsonStorage<Settings> }
	}) {
		const [settings, set] = useSettings(api.jsonStorage, DEFAULTS)
		const on = settings.enabled !== false
		const now = Date.now()
		const chats = chatsOf(settings)
		const waiting = Object.entries(chats)
			// Oldest first: the one you have left longest is the one to answer.
			.sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))
		const oldest = waiting[0]

		const dismiss = (id: string) => {
			const next = { ...chatsOf(current()) }
			delete next[id]
			set({ chats: next })
		}

		return (
			<Page>
				<Intro text="The conversations whose last message is theirs. Send anything in a chat and it leaves this list; nothing is uploaded and nothing is answered for you." />
				<Hero
					title={
						waiting.length === 0
							? 'Nobody is waiting on you'
							: `${waiting.length} ${plural(waiting.length, 'chat is', 'chats are')} waiting on you`
					}
					line={
						oldest
							? `The oldest is ${oldest[1].name || oldest[0]}, ${ago(oldest[1].at, now)}.`
							: on
								? 'A message you leave unanswered shows up here.'
								: 'Tracking is off, so nothing is being listed.'
					}
					tone={waiting.length ? 'brand' : on ? 'muted' : 'danger'}
					action={
						waiting.length
							? { label: 'Forget everyone', onPress: () => set({ chats: {} }) }
							: undefined
					}
				/>
				<Section
					title={waiting.length === 0 ? 'Nothing waiting' : `Waiting on you (${waiting.length})`}
					description={
						waiting.length === 0
							? undefined
							: 'Oldest first. Tap a chat to take it off the list.'
					}
				>
					{waiting.length === 0 ? (
						<Row
							label="Nothing waiting."
							subLabel="A DM whose last message is theirs appears here."
						/>
					) : (
						waiting.map(([id, chat]) => (
							<Row
								key={id}
								label={`${chat.name || id} · ${ago(chat.at, now)}`}
								subLabel={`“${chat.preview}”`}
								onPress={() => dismiss(id)}
							/>
						))
					)}
				</Section>
				<Section title="What it counts">
					<SwitchRow
						label="Track DMs"
						subLabel="Off stops new chats being added; the list stays."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<SwitchRow
						label="Include group DMs"
						subLabel="A group counts as waiting until you say something in it."
						value={settings.groups === true}
						onChange={groups => set({ groups })}
					/>
					<Row
						label="Only what it saw"
						subLabel="The plugin starts with an empty list. A chat whose last message arrived before that is not listed until something new happens there."
					/>
					<Note text="Everything stays in this plugin's own storage on this device. No account, no server, no token, and no message is ever sent from here." />
				</Section>
			</Page>
		)
	},
})
