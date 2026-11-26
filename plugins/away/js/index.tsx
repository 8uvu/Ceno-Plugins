// Away, by cenotaph. While you are out, Discord answers your DMs for you: a
// short reply you wrote, sent once per person per cooldown, through Discord's
// own message action.
//
// Off by default, DMs only, never a bot, never your own message, and never twice
// to the same chat before the cooldown is up. It works only while Discord is
// open: there is no background service, so a message that arrives while the app
// is closed gets no reply. The page says all of that rather than implying more.
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import {
	ago,
	channelName,
	plural,
	selfId,
	storeNamed,
	userName,
} from '../../_shared/lib/format'
import {
	Choices,
	Field,
	Hero,
	Intro,
	Note,
	Page,
	Row,
	Section,
	SwitchRow,
} from '../../_shared/lib/kit'
import { useSettings } from '../../_shared/lib/settings'
import { say } from '../../_shared/lib/toast'
import { asRecord, errorMessage } from '../../_shared/types'
import type { JsonStorage, Logger } from '../../_shared/types'

interface Reply {
	channelId: string
	name: string
	at: number
}

interface Settings {
	enabled: boolean
	text: string
	// Hours between two replies to the same chat.
	hours: number
	groups: boolean
	// channelId -> when the last auto-reply went out there.
	sent: Record<string, number>
	log: Reply[]
}

const DEFAULTS: Settings = {
	enabled: false,
	text: "I'm away at the moment — I'll get back to you when I can.",
	hours: 6,
	groups: false,
	sent: {},
	log: [],
}

const CHOICES = [
	{ value: '1', label: 'Every hour' },
	{ value: '3', label: 'Every 3 hours' },
	{ value: '6', label: 'Every 6 hours' },
	{ value: '12', label: 'Every 12 hours' },
	{ value: '24', label: 'Once a day' },
]

// A week of cooldowns is more than any list needs.
const KEEP_SENT_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LOG = 20
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

function hoursOf(settings: Settings): number {
	const value = Number(settings.hours)
	if (!Number.isFinite(value)) return DEFAULTS.hours
	return Math.max(1, Math.min(24, Math.round(value)))
}

function replyText(settings: Settings): string {
	const text = typeof settings.text === 'string' ? settings.text.trim() : ''
	return text || DEFAULTS.text
}

// Discord's message actions, the same module the delete plugin uses. Only the
// send side is needed here; a build without it says so on the page instead of
// pretending the reply went out.
interface MessageActions {
	sendMessage?(channelId: string, message: unknown, ...rest: unknown[]): unknown
}

function actions(): MessageActions | null {
	try {
		const [module] = lookupModule(withProps('deleteMessage', 'sendMessage'))
		const record = asRecord(module)
		return typeof record.sendMessage === 'function'
			? (module as unknown as MessageActions)
			: null
	} catch {
		return null
	}
}

function mark(channelId: string, name: string): void {
	const settings = current()
	const now = Date.now()
	const sent: Record<string, number> = { ...(settings.sent ?? {}) }
	sent[channelId] = now
	for (const key of Object.keys(sent)) {
		if (now - (sent[key] ?? 0) > KEEP_SENT_MS) delete sent[key]
	}
	const log: Reply[] = [
		{ channelId, name: name || channelName(channelId), at: now },
		...(Array.isArray(settings.log) ? settings.log : []),
	].slice(0, MAX_LOG)
	write({ sent, log })
}

function failed(error: unknown): void {
	logger?.warn?.('[Away] could not send the reply', error)
	say('away', 'Could not send the away reply: ' + errorMessage(error), 'critical')
}

// Runs one send. A thenable is waited for before the cooldown is stamped, so a
// failed send does not silence the next one.
function attempt(
	run: () => unknown,
	channelId: string,
	name: string,
): boolean {
	try {
		const result = run()
		if (result && typeof (result as { then?: unknown }).then === 'function') {
			Promise.resolve(result).then(
				() => {
					mark(channelId, name)
					say('away', 'Sent the away reply.', 'success')
				},
				failed,
			)
			return true
		}
		mark(channelId, name)
		say('away', 'Sent the away reply.', 'success')
		return true
	} catch {
		return false
	}
}

function sendReply(channelId: string, name: string, settings: Settings): void {
	const send = actions()?.sendMessage
	if (typeof send !== 'function') {
		say(
			'away',
			'This build does not expose the message action, so nothing was sent.',
			'critical',
		)
		return
	}
	const text = replyText(settings)
	// Current builds take the message object, older ones the text itself; the
	// second form is only tried when the first one threw before sending.
	if (attempt(() => send(channelId, { content: text }), channelId, name)) return
	if (attempt(() => send(channelId, text), channelId, name)) return
	failed(new Error('the message action refused the call'))
}

function watch(payload: unknown): void {
	const settings = current()
	if (settings.enabled !== true) return
	const message = asRecord(asRecord(payload).message)
	const author = asRecord(message.author)
	const me = selfId()
	if (!me || author.id === me) return
	if (author.bot === true) return
	const channelId = message.channel_id == null ? '' : String(message.channel_id)
	if (!channelId) return
	// The channel is checked, not assumed: a server channel must never get an
	// automatic reply, and a missing store entry is not a reason to guess.
	let channel: Record<string, unknown> = {}
	try {
		const lookup = storeNamed('ChannelStore')?.getChannel
		if (typeof lookup === 'function') {
			channel = asRecord((lookup as (id: string) => unknown)(channelId))
		}
	} catch {}
	const type = typeof channel.type === 'number' ? channel.type : -1
	const wanted = type === DM || (type === GROUP_DM && settings.groups === true)
	if (!wanted) return
	const last = (settings.sent ?? {})[channelId] ?? 0
	if (Date.now() - last < hoursOf(settings) * 60 * 60 * 1000) return
	const name =
		typeof channel.name === 'string' && channel.name
			? '#' + channel.name
			: typeof author.globalName === 'string' && author.globalName
				? author.globalName
				: typeof author.username === 'string' && author.username
					? author.username
					: typeof author.id === 'string'
						? userName(author.id)
						: channelId
	sendReply(channelId, name, settings)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		cleanup(
			// A listener only: the payload goes back untouched.
			onFluxEventDispatched('MESSAGE_CREATE', (payload: unknown) => {
				try {
					watch(payload)
				} catch (error) {
					logger?.warn?.('[Away] skipped a message', error)
				}
				return payload
			}),
		)
		logger?.log?.('[Away] started')
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
		const on = settings.enabled === true
		const hours = hoursOf(settings)
		const log = Array.isArray(settings.log) ? settings.log : []
		const now = Date.now()
		const ready = actions() !== null

		return (
			<Page>
				<Intro text="Away answers your DMs while you are out. It sends one short reply, as you, at most once per chat every few hours, and only while Discord is open." />
				<Hero
					title={on ? 'Away is on' : 'Away is off'}
					line={
						on
							? `Replies to ${settings.groups === true ? 'DMs and group DMs' : 'DMs'} at most once every ${hours} ${plural(hours, 'hour')}.`
							: 'Turn it on below and Discord will answer for you.'
					}
					tone={on ? 'brand' : 'muted'}
					action={
						on
							? { label: 'Turn off', onPress: () => set({ enabled: false }) }
							: { label: 'Turn on', onPress: () => set({ enabled: true }) }
					}
				/>
				<Section
					title="The reply"
					description="Keep it short and honest. It is sent from your account."
				>
					<Field
						label="What it says"
						value={typeof settings.text === 'string' ? settings.text : ''}
						onChange={text => set({ text })}
						placeholder={DEFAULTS.text}
						multiline
						maxLength={280}
						description="An empty field uses the default line."
					/>
					<SwitchRow
						label="Reply in group DMs too"
						subLabel="Off answers one-to-one DMs only."
						value={settings.groups === true}
						onChange={groups => set({ groups })}
					/>
				</Section>
				<Section title="How often" description="One reply per chat in this window.">
					<Choices
						value={String(hours)}
						options={CHOICES}
						onChange={value => set({ hours: Number(value) })}
					/>
				</Section>
				<Section
					title={log.length === 0 ? 'Nothing sent yet' : `Recent replies (${log.length})`}
					description={log.length === 0 ? undefined : 'Newest first.'}
				>
					{log.length === 0 ? (
						<Row
							label="Nothing sent yet."
							subLabel="A reply shows up here after it goes out."
						/>
					) : (
						log.map(entry => (
							<Row
								key={entry.channelId + ':' + entry.at}
								label={entry.name || channelName(entry.channelId)}
								subLabel={`Replied ${ago(entry.at, now)}`}
							/>
						))
					)}
					{log.length ? (
						<Row
							label="Forget recent replies"
							subLabel="Clears this list, not the cooldowns."
							onPress={() => set({ log: [] })}
						/>
					) : null}
				</Section>
				<Section title="Limits">
					<Row
						label="Only while Discord is open"
						subLabel="A message that arrives while the app is closed gets no reply."
					/>
					<Row
						label="Never a bot, never yourself"
						subLabel="Your own messages and bots are ignored."
					/>
					<Row
						label="Message action"
						subLabel={
							ready
								? 'Found on this build.'
								: 'Not found on this build, so nothing can be sent.'
						}
					/>
					<Note text="The reply is sent through Discord's own action with the session already on the app. No account, no server, no token." />
				</Section>
			</Page>
		)
	},
})
