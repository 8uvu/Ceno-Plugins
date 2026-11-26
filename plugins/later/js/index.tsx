// Later, by cenotaph. Hold a message and ask to be pinged about it in an hour,
// in three hours, or tomorrow.
//
// The pings live in this plugin's own storage and fire as a toast; there is no
// alarm, no notification permission, no account and no token. A ping that came
// due while the app was closed fires the next time the plugin starts, which is
// the honest limit of a plugin with no background service.
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { Stores } from '@valenced/discord/flux'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { addMessageMenuRows } from '../../_shared/actionSheet'
import { plural } from '../../_shared/lib/format'
import {
	Hero,
	Intro,
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE

interface Choice {
	key: string
	label: string
	// What the ping says it was set for.
	when: string
	after: number
}

const CHOICES: Choice[] = [
	{ key: '1h', label: 'Ping me in 1 hour', when: '1 hour', after: HOUR },
	{ key: '3h', label: 'Ping me in 3 hours', when: '3 hours', after: 3 * HOUR },
	{ key: '1d', label: 'Ping me tomorrow', when: 'tomorrow', after: 24 * HOUR },
]

interface Ping {
	// One per message and delay, so pressing the same row twice replaces it.
	id: string
	messageId: string
	channelId: string
	channelName: string
	authorName: string
	preview: string
	at: number
	createdAt: number
}

interface Settings {
	enabled: boolean
	pings: Ping[]
}

const DEFAULTS: Settings = { enabled: true, pings: [] }

// A ceiling, so the list cannot grow forever if the rows are pressed a lot.
const MAX_PINGS = 50
// How often a due ping is looked for while the app is open.
const CHECK_MS = 30000
// Previews are clipped so a long message cannot fill a toast.
const PREVIEW = 100

interface MessageLike {
	id?: string
	content?: string
	channel_id?: string
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
let timer: ReturnType<typeof setInterval> | null = null
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

function channelName(id: string): string {
	const lookup = storeNamed('ChannelStore')?.getChannel
	if (typeof lookup !== 'function') return id
	try {
		const channel = (lookup as (id: string) => unknown)(id)
		const record =
			channel && typeof channel === 'object'
				? (channel as Record<string, unknown>)
				: {}
		if (typeof record.name === 'string' && record.name) return '#' + record.name
		const recipients = Array.isArray(record.recipients) ? record.recipients : []
		const other = recipients[0]
		if (other && typeof other === 'object') {
			const person = other as Record<string, unknown>
			const name = person.globalName ?? person.username
			if (typeof name === 'string' && name) return name
		}
	} catch {}
	return id
}

function clip(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim()
	if (!clean) return '(no text)'
	return clean.length > PREVIEW ? clean.slice(0, PREVIEW - 1) + '…' : clean
}

function toast(text: string): void {
	try {
		ToastActionCreators.open('later', { text })
		return
	} catch {}
	try {
		ToastActionCreators.open({ key: 'later', content: text })
	} catch {}
}

function iconFor(name: string): unknown {
	try {
		return lookupGeneratedIconComponent(name)
	} catch {
		return undefined
	}
}

function when(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((at - now) / MINUTE))
	if (minutes < 1) return 'any moment'
	if (minutes < 60) return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
	const days = Math.round(hours / 24)
	return `in ${days} ${days === 1 ? 'day' : 'days'}`
}

function pingsOf(settings: Settings): Ping[] {
	return Array.isArray(settings.pings) ? settings.pings : []
}

// ─── Setting and firing a ping ───────────────────────────────────────────────

function addPing(message: MessageLike, choice: Choice): void {
	const settings = current()
	const messageId = typeof message.id === 'string' ? message.id : ''
	if (!messageId) return
	if (settings.enabled === false) {
		toast('Later is switched off in its settings.')
		return
	}
	const channelId =
		typeof message.channel_id === 'string' ? message.channel_id : ''
	const author = message.author
	const authorName =
		author?.globalName ??
		author?.global_name ??
		author?.username ??
		(typeof author?.id === 'string' ? userName(author.id) : '')
	const at = Date.now() + choice.after
	const ping: Ping = {
		id: messageId + ':' + choice.key,
		messageId,
		channelId,
		channelName: channelId ? channelName(channelId) : '',
		authorName,
		preview: clip(typeof message.content === 'string' ? message.content : ''),
		at,
		createdAt: Date.now(),
	}
	write({
		pings: [
			ping,
			...pingsOf(settings).filter(existing => existing.id !== ping.id),
		].slice(0, MAX_PINGS),
	})
	toast(`Ping set for ${choice.when}.`)
}

function cancelFor(messageId: string): void {
	const settings = current()
	const pings = pingsOf(settings)
	if (!pings.some(ping => ping.messageId === messageId)) return
	write({ pings: pings.filter(ping => ping.messageId !== messageId) })
	toast('Ping cancelled.')
}

// Fires everything that came due. A ping that came due while the app was closed
// is still waiting on the next start, which is why this runs before the timer.
function check(): void {
	const settings = current()
	const pings = pingsOf(settings)
	if (!pings.length) return
	const now = Date.now()
	const due = pings.filter(ping => ping.at <= now)
	if (!due.length) return
	write({ pings: pings.filter(ping => ping.at > now) })
	for (const ping of due.slice(0, 3)) {
		const where = ping.channelName || ping.channelId
		toast(
			`Ping: “${ping.preview}” — ${ping.authorName || 'someone'}${where ? ' in ' + where : ''}`,
		)
	}
	if (due.length > 3) toast(`And ${due.length - 3} more pings.`)
}

// ─── The message menu ────────────────────────────────────────────────────────

function menuRows(message: MessageLike): unknown[] {
	const design = asRecord(Design)
	const Row = design.ActionSheetRow as RowComponent | undefined
	if (typeof Row !== 'function') return []
	const messageId = typeof message.id === 'string' ? message.id : ''
	if (!messageId) return []
	const Group = Row.Group
	const Icon = Row.Icon
	const icon = (): unknown => {
		if (typeof Icon !== 'function') return undefined
		const component = iconFor('ClockIcon')
		return component ? <Icon IconComponent={component} /> : undefined
	}
	const rows: unknown[] = CHOICES.map(choice => (
		<Row
			key={'later-' + choice.key}
			label={choice.label}
			icon={icon()}
			onPress={() => addPing(message, choice)}
		/>
	))
	const existing = pingsOf(current()).some(ping => ping.messageId === messageId)
	if (existing) {
		rows.push(
			<Row
				key="later-cancel"
				label="Cancel the ping for this message"
				onPress={() => cancelFor(messageId)}
			/>,
		)
	}
	if (typeof Group === 'function')
		return [<Group key="later">{rows}</Group>]
	return rows
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		// Anything that came due while the app was closed fires now.
		check()
		timer = setInterval(() => {
			try {
				check()
			} catch (error) {
				logger?.warn?.('[Later] could not fire a ping', error)
			}
		}, CHECK_MS)
		cleanup(() => {
			if (timer) clearInterval(timer)
			timer = null
		})
		cleanup(
			addMessageMenuRows(props => {
				const message = asRecord(props.message) as MessageLike
				return menuRows(message)
			}, logger),
		)
		logger?.log?.('[Later] started')
	},
	stop() {
		if (timer) clearInterval(timer)
		timer = null
		live = null
	},
	SettingsComponent({
		api,
	}: {
		api: {
			jsonStorage: {
				use(): unknown
				set(patch: Partial<Settings>): Promise<unknown>
			}
		}
	}) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const now = Date.now()
		const pings = pingsOf(settings)
			.filter(ping => ping && typeof ping.at === 'number')
			.sort((a, b) => a.at - b.at)
		const on = settings.enabled !== false
		const next = pings[0]
		return (
			<Page>
				<Intro text="Later holds a message for you: hold it, pick an hour, three hours or tomorrow, and this device brings it back as a toast when it comes due." />
				<Hero
					title={
						pings.length === 0
							? 'Nothing waiting'
							: `${pings.length} ${plural(pings.length, 'ping')} waiting`
					}
					line={
						next
							? `The next one is ${when(next.at, now)}.`
							: 'Hold a message and pick a time.'
					}
					tone={pings.length ? 'brand' : 'muted'}
				/>
				<Section
					title="Pings"
					description="Off stops new ones; the pings already set still fire."
				>
					<SwitchRow
						label="Allow pings"
						subLabel="The menu offers an hour, three hours and tomorrow."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<Row
						label={`Cancel every ping (${pings.length})`}
						subLabel="Removes them from this device."
						onPress={() => set({ pings: [] })}
					/>
				</Section>
				<Section
					title={
						pings.length === 0 ? 'Nothing waiting' : `Waiting (${pings.length})`
					}
					description={
						pings.length === 0 ? 'Hold a message and set a ping.' : 'Soonest first.'
					}
				>
					{pings.length === 0 ? (
						<Row label="Nothing waiting." subLabel="Hold a message and set a ping." />
					) : (
						pings.map(ping => (
							<Row
								key={ping.id}
								label={`“${ping.preview}”`}
								subLabel={`${when(ping.at, now)} · ${ping.authorName || 'someone'}${ping.channelName ? ' in ' + ping.channelName : ''}`}
							/>
						))
					)}
				</Section>
				<Section title="While the app is closed">
					<Row
						label="A ping waits for you"
						subLabel="A ping that came due while the app was closed is shown the next time Discord opens, not as a phone notification."
					/>
				</Section>
			</Page>
		)
	},
})

import { asRecord } from '../../_shared/types'