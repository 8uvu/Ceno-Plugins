// Second Thoughts, by cenotaph. Holds a text message for a few seconds before
// Discord sends it, so a typo, a wrong chat or a message you regret at the last
// second can be cancelled. The cancelled text stays on this page, because no
// plugin can put it back in the composer.

import { Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { ago, channelName, clip } from '../../_shared/lib/format'
import {
	Choices,
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
import { asRecord, errorMessage, type JsonStorage } from '../../_shared/types'

type SendMessage = (
	channelId: string,
	message: unknown,
	...rest: unknown[]
) => unknown

interface MessageActions {
	sendMessage?: SendMessage
}

interface Pending {
	id: string
	channelId: string
	content: string
	at: number
	sendAt: number
}

interface Cancelled {
	id: string
	channelId: string
	content: string
	at: number
}

interface Settings {
	enabled: boolean
	delay: number
	holdDms: boolean
	holdServers: boolean
	pending: Pending[]
	cancelled: Cancelled[]
}

const DEFAULTS: Settings = {
	enabled: true,
	delay: 5,
	// A DM is where a wrong message costs the most; a server channel with slow
	// mode or a busy conversation is where a hold is least welcome.
	holdDms: true,
	holdServers: false,
	pending: [],
	cancelled: [],
}

const DELAYS = [3, 5, 8, 12]
const QUEUE_CAP = 10
const CANCELLED_CAP = 20
const CANCELLED_TEXT_CAP = 500

type Job = {
	timer: ReturnType<typeof setTimeout>
	settle: () => void
}

// Live sends only: a held message cannot survive the app closing, so nothing
// here is written back to storage as something that will still be delivered.
const jobs = new Map<string, Job>()
let storage: JsonStorage<Settings> | null = null

function read(): Settings {
	return { ...DEFAULTS, ...(storage?.cache ?? {}) }
}

function save(patch: Partial<Settings>) {
	if (!storage) return
	void storage.set(patch)
}

function delayFor(settings: Settings): number {
	const seconds = Number(settings.delay)
	const chosen = DELAYS.includes(seconds) ? seconds : DEFAULTS.delay
	return chosen * 1000
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

function channelType(channelId: string): number | null {
	try {
		const channel = Stores.ChannelStore?.getChannel?.(channelId)
		return typeof channel?.type === 'number' ? channel.type : null
	} catch {
		return null
	}
}

// What, if anything, this send should hold. A message with an attachment, a
// file upload or a slash command goes out at once: those already have their own
// confirmation steps, and delaying them would only confuse the uploader.
function contentToHold(
	settings: Settings,
	channelId: string,
	message: unknown,
): string | null {
	if (settings.enabled === false) return null
	const record = asRecord(message)
	const content = typeof record.content === 'string' ? record.content.trim() : ''
	if (!content || content.startsWith('/')) return null
	if (Array.isArray(record.attachments) && record.attachments.length) return null
	if (record.files !== undefined && record.files !== null) return null

	const type = channelType(channelId)
	const isDm = type === 1 || type === 3
	if (isDm ? settings.holdDms === false : settings.holdServers === false)
		return null
	return content
}

// Cancelling drops the send and keeps the text here. There is no clipboard
// module in this API, so the page is the place it cannot be lost from.
function cancel(id: string): void {
	const job = jobs.get(id)
	if (!job) return
	const settings = read()
	const entry = (settings.pending ?? []).find(item => item.id === id)
	clearTimeout(job.timer)
	jobs.delete(id)
	const cancelled = entry
		? [
				{
					id: entry.id,
					channelId: entry.channelId,
					content: entry.content.slice(0, CANCELLED_TEXT_CAP),
					at: Date.now(),
				},
				...(settings.cancelled ?? []),
			].slice(0, CANCELLED_CAP)
		: (settings.cancelled ?? [])
	save({
		pending: (settings.pending ?? []).filter(item => item.id !== id),
		cancelled,
	})
	job.settle()
	say('second-thoughts', 'Cancelled — the text is waiting on this page.')
}

function hold(
	settings: Settings,
	channelId: string,
	content: string,
	deliver: () => unknown,
): Promise<unknown> {
	const now = Date.now()
	const wait = delayFor(settings)
	const entry: Pending = {
		id: now.toString(36) + Math.random().toString(36).slice(2, 8),
		channelId,
		content,
		at: now,
		sendAt: now + wait,
	}
	save({
		pending: [...(settings.pending ?? []), entry].slice(-QUEUE_CAP),
		cancelled: (settings.cancelled ?? []).slice(0, CANCELLED_CAP),
	})
	say(
		'second-thoughts',
		`Sending in ${Math.round(wait / 1000)}s — Second Thoughts can cancel it.`,
	)
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			jobs.delete(entry.id)
			save({
				pending: (read().pending ?? []).filter(item => item.id !== entry.id),
			})
			try {
				resolve(deliver())
			} catch (error) {
				reject(error)
			}
		}, wait)
		jobs.set(entry.id, { timer, settle: () => resolve(undefined) })
	})
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		// The device's storage type is wider (its cache may be undefined); the
		// fields this plugin reads are exactly what Settings declares.
		storage = jsonStorage as unknown as JsonStorage<Settings>
		const store = storage
		// Anything left from a previous run was never sent and never will be.
		if ((store.cache?.pending ?? []).length) save({ pending: [] })

		const found = actions()
		if (!found?.sendMessage) {
			logger?.warn?.(
				'[SecondThoughts] no message actions module; sends are not held',
			)
		} else {
			const target = found as unknown as { sendMessage: SendMessage }
			const original = target.sendMessage as SendMessage
			try {
				target.sendMessage = function (
					this: unknown,
					channelId: string,
					message: unknown,
					...rest: unknown[]
				) {
					try {
						const settings = read()
						const content = contentToHold(settings, channelId, message)
						if (!content) return original.call(this, channelId, message, ...rest)
						return hold(settings, channelId, content, () =>
							original.call(this, channelId, message, ...rest),
						)
					} catch (error) {
						logger?.warn?.(
							'[SecondThoughts] could not hold a send',
							errorMessage(error),
						)
						return original.call(this, channelId, message, ...rest)
					}
				}
				cleanup(() => {
					try {
						target.sendMessage = original
					} catch {}
				})
			} catch (error) {
				logger?.warn?.(
					'[SecondThoughts] could not patch the send action',
					errorMessage(error),
				)
			}
		}

		cleanup(() => {
			// Held sends are dropped, never flushed late: silence is better than a
			// message arriving minutes after the moment passed.
			for (const job of jobs.values()) {
				clearTimeout(job.timer)
				job.settle()
			}
			jobs.clear()
			save({ pending: [] })
			storage = null
		})
		logger?.log?.('[SecondThoughts] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const pending = settings.pending ?? []
		const cancelled = settings.cancelled ?? []
		const now = Date.now()
		const on = settings.enabled !== false
		const delay = Number(settings.delay ?? DEFAULTS.delay)
		const ready = actions() !== null
		return (
			<Page>
				<Intro text="Second Thoughts holds a text message for a few seconds before Discord sends it. While it waits it is listed here, and cancelling it keeps the text on this page so nothing you typed is lost." />
				<Hero
					title={
						!on
							? 'Second Thoughts is off'
							: pending.length
								? `${pending.length} ${pending.length === 1 ? 'message is' : 'messages are'} waiting`
								: 'Nothing is waiting'
					}
					line={
						!on
							? 'Every message goes out the moment you send it.'
							: pending.length
								? 'Send it now or cancel it below.'
								: `Text messages wait ${delay} ${delay === 1 ? 'second' : 'seconds'} before they leave.`
					}
					tone={on ? 'brand' : 'muted'}
				/>
				<Section title="This device">
					<SwitchRow
						label="Hold my messages"
						subLabel="Off sends everything the moment you tap send."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<Row
						label="How long to hold"
						subLabel={`${delay} ${delay === 1 ? 'second' : 'seconds'} — enough to catch a mistake, short enough not to feel broken.`}
					/>
					<Choices
						value={String(delay)}
						options={DELAYS.map(seconds => ({
							value: String(seconds),
							label: `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
						}))}
						onChange={value => set({ delay: Number(value) })}
					/>
					<SwitchRow
						label="Hold in DMs"
						subLabel="Where a wrong message costs the most."
						value={settings.holdDms !== false}
						onChange={holdDms => set({ holdDms })}
					/>
					<SwitchRow
						label="Hold in servers"
						subLabel="Off by default: a busy channel with slow mode is no place to wait."
						value={settings.holdServers === true}
						onChange={holdServers => set({ holdServers })}
					/>
				</Section>
				<Section
					title="Waiting to send"
					description="Tap one to cancel it. The text stays under Cancelled."
				>
					{pending.length ? (
						pending.map(item => {
							const left = Math.max(
								0,
								Math.ceil((item.sendAt - now) / 1000),
							)
							return (
								<Row
									key={item.id}
									label={clip(item.content, 60)}
									subLabel={`${channelName(item.channelId)} · ${left === 1 ? '1 second' : `${left} seconds`} left — tap to cancel`}
									onPress={() => cancel(item.id)}
								/>
							)
						})
					) : (
						<Row
							label="Nothing is waiting"
							subLabel="Type and send something, and it appears here for a few seconds."
						/>
					)}
				</Section>
				<Section
					title="Cancelled"
					description="What you stopped, newest first, so the text is never gone."
				>
					{cancelled.length ? (
						<>
							{cancelled.slice(0, 5).map(item => (
								<Row
									key={item.id}
									label={clip(item.content, 60)}
									subLabel={`${channelName(item.channelId)} · ${ago(item.at, now)}`}
								/>
							))}
							<Row
								label="Clear cancelled messages"
								subLabel="Removes the text from this page."
								onPress={() => set({ cancelled: [] })}
							/>
						</>
					) : (
						<Row
							label="Nothing cancelled"
							subLabel="Cancelled messages are kept here, not thrown away."
						/>
					)}
				</Section>
				<Section
					title="This build"
					description="What the client exposes, so a hold that never happens can be reported exactly."
				>
					<Row
						label="Send action"
						subLabel={
							ready
								? 'Ready. Text messages go through the hold.'
								: 'Missing. Nothing can be held on this build; messages send as usual.'
						}
					/>
					<Row
						label="After a cancel"
						subLabel="The text stays on this page. A build may also clear the composer; nothing is lost either way."
					/>
				</Section>
				<Note text="A held message is dropped if Discord closes or this plugin stops — it is never sent late. Attachments, file uploads and slash commands are not held." />
			</Page>
		)
	},
})
