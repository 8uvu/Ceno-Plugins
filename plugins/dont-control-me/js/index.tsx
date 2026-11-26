// Don't Control Me, by cenotaph. Puts you back when someone moves, mutes or
// drops you — and can be told exactly which of that you want.

import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { plural } from '../../_shared/lib/format'
import {
	Choices,
	Hero,
	Intro,
	Page,
	Row,
	Section,
	SwitchRow,
} from '../../_shared/lib/kit'
import { useSettings } from '../../_shared/lib/settings'
import type {
	JsonStorage,
	VoiceActions,
	VoiceStateActions,
} from '../../_shared/types'

type VoiceState = {
	userId?: string
	user_id?: string
	channelId?: string
	channel_id?: string
	// Set by a moderator: your microphone is closed for everyone in the call.
	mute?: boolean
	deaf?: boolean
}

type VoiceStatePayload = VoiceState & {
	voiceState?: VoiceState
	voiceStates?: VoiceState[]
}

// The client's own mute buttons, used when a reconnect comes back muted.
interface SelfMuteActions {
	setSelfMute?(muted: boolean): void
	setSelfDeaf?(deafened: boolean): void
}

interface Settings {
	// Rejoin the call when Discord drops me out of it.
	reconnect: boolean
	// How long to wait before going back, in seconds.
	rejoinDelay: number
	moveToPinned: boolean
	autoUnmute: boolean
	autoUndeafen: boolean
	pinnedChannelId: string | null
	// The call I was last in, kept so a drop can go back to it even with no pin.
	lastChannelId: string | null
}

const DEFAULTS: Settings = {
	reconnect: true,
	rejoinDelay: 2,
	moveToPinned: true,
	autoUnmute: true,
	autoUndeafen: true,
	pinnedChannelId: null,
	lastChannelId: null,
}

// How long to wait before pulling you back. A moment's pause reads as Discord
// reconnecting; going back instantly fights a disconnect that is still settling.
const DELAYS = [
	{ value: 0, label: 'Straight away' },
	{ value: 2, label: '2 seconds' },
	{ value: 5, label: '5 seconds' },
	{ value: 10, label: '10 seconds' },
]

// Leaving a call yourself reports the same empty voice state as being dropped,
// so a short window after your own Disconnect is left alone.
const OWN_LEAVE_WINDOW = 5000

function selfId(): string {
	try {
		return String(Stores.UserStore?.getCurrentUser?.()?.id ?? '')
	} catch {
		return ''
	}
}

function idOf(value: unknown): string | null {
	return value === undefined || value === null || value === ''
		? null
		: String(value)
}

// The channel this account is connected to. The selected-channel store is only
// what is open on screen — using it here rejoined a call you were still in.
function connectedVoiceChannelId(): string | null {
	const me = selfId()
	if (!me) return null
	try {
		const state = Stores.VoiceStateStore?.getVoiceStateForUser?.(me)
		return idOf(state?.channelId ?? state?.channel_id)
	} catch {
		return null
	}
}

// The voice channel of the chat on screen, used to pin one you are looking at.
function viewedVoiceChannelId(): string | null {
	try {
		const selected =
			Stores.SelectedChannelStore ?? Stores.SelectedVoiceChannelStore
		return idOf(selected?.getVoiceChannelId?.() ?? selected?.getChannelId?.())
	} catch {
		return null
	}
}

// A channel id on its own means nothing on the page; the name does.
function voiceChannelName(channelId: string): string {
	try {
		const name = Stores.ChannelStore?.getChannel?.(channelId)?.name
		return name ? `#${String(name)}` : channelId
	} catch {
		return channelId
	}
}

function findVoiceActions(): VoiceActions | null {
	try {
		const [mod] = lookupModule(withProps('selectVoiceChannel'))
		if (mod && typeof mod.selectVoiceChannel === 'function')
			return mod as unknown as VoiceActions
	} catch {}
	return null
}

function findVoiceStateActions(): VoiceStateActions | null {
	try {
		const [mod] = lookupModule(withProps('updateVoiceState'))
		if (mod && typeof mod.updateVoiceState === 'function')
			return mod as unknown as VoiceStateActions
	} catch {}
	return null
}

function findSelfMuteActions(): SelfMuteActions | null {
	try {
		const [mod] = lookupModule(withProps('setSelfMute'))
		if (mod && typeof mod.setSelfMute === 'function')
			return mod as unknown as SelfMuteActions
	} catch {}
	return null
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		let warned = false
		let stateWarned = false
		let watchingLeave = false
		let leftAt = 0
		let rejoinTimer: ReturnType<typeof setTimeout> | null = null
		// The same join is never fired twice in a row within a second, but a
		// different channel is always obeyed: a fast drop-then-rejoin used to be
		// swallowed by a plain 1s cooldown.
		let lastAction = { channelId: '', at: 0 }
		const guarded = (channelId: string, fn: () => void) => {
			const now = Date.now()
			if (lastAction.channelId === channelId && now - lastAction.at < 1000)
				return
			lastAction = { channelId, at: now }
			try {
				fn()
			} catch (error) {
				logger?.error?.('[DontControlMe] action failed', error)
			}
		}

		const join = (channelId: string) => {
			const voice = findVoiceActions()
			if (!voice) {
				if (!warned) {
					warned = true
					logger?.error?.(
						'[DontControlMe] no voice actions module; rejoin is idle',
					)
				}
				return
			}
			guarded(channelId, () => voice.selectVoiceChannel(channelId))
		}

		// Discord's own Disconnect goes through the same action the plugin uses to
		// join, with an empty channel id. Watching for that call is the only way to
		// tell "I left" from "I was dropped" — both dispatch an empty voice state.
		const watchOwnLeave = () => {
			if (watchingLeave) return
			const voice = findVoiceActions()
			if (!voice) return
			const mod = voice as unknown as {
				selectVoiceChannel: (
					channelId: string | null,
					...rest: unknown[]
				) => unknown
			}
			const original = mod.selectVoiceChannel
			try {
				mod.selectVoiceChannel = function (
					this: unknown,
					channelId: string | null,
					...rest: unknown[]
				) {
					if (!channelId) leftAt = Date.now()
					return original.call(this, channelId, ...rest)
				}
			} catch (error) {
				logger?.warn?.(
					'[DontControlMe] could not watch for your own disconnect',
					error,
				)
				return
			}
			watchingLeave = true
			cleanup(() => {
				try {
					mod.selectVoiceChannel = original
				} catch {}
			})
		}

		const undoMute = (channelId: string, unmute: boolean, undeafen: boolean) => {
			const state = findVoiceStateActions()
			if (state) {
				guarded(channelId + ':state', () =>
					state.updateVoiceState(channelId, {
						mute: unmute ? false : undefined,
						deaf: undeafen ? false : undefined,
					}),
				)
			}
			// A reconnect can also come back with the client's own mute applied;
			// the client's buttons clear that the same way a tap would.
			const self = findSelfMuteActions()
			if (self) {
				guarded(channelId + ':self', () => {
					if (unmute) self.setSelfMute?.(false)
					if (undeafen) self.setSelfDeaf?.(false)
				})
			}
			if (!state && !self && !stateWarned) {
				stateWarned = true
				logger?.warn?.(
					'[DontControlMe] no mute actions module; mute undo is idle',
				)
			}
		}

		cleanup(
			onFluxEventDispatched(
				'VOICE_STATE_UPDATE',
				(payload: VoiceStatePayload) => {
					try {
						watchOwnLeave()
						const cfg: Settings = { ...DEFAULTS, ...(jsonStorage.cache ?? {}) }
						const state = payload?.voiceState ?? payload
						const states = Array.isArray(payload?.voiceStates)
							? payload.voiceStates
							: [state]
						const me = selfId()
						for (const vs of states) {
							const userId = String(
								vs?.userId ?? vs?.user_id ?? payload?.userId ?? '',
							)
							if (!me || (userId && userId !== me)) continue
							const channelId = idOf(
								vs?.channelId ?? vs?.channel_id ?? payload?.channelId,
							)
							const pinned = cfg.pinnedChannelId ?? null

							// In a call: remember it, undo a mute, and go back to the pin
							// if someone moved you out of it.
							if (channelId) {
								if (channelId !== cfg.lastChannelId) {
									jsonStorage.set({ lastChannelId: channelId })
								}
								const muted = vs?.mute ?? payload?.mute
								const deafened = vs?.deaf ?? payload?.deaf
								if ((muted && cfg.autoUnmute) || (deafened && cfg.autoUndeafen)) {
									undoMute(
										channelId,
										!!(muted && cfg.autoUnmute),
										!!(deafened && cfg.autoUndeafen),
									)
								}
								if (pinned && cfg.moveToPinned && channelId !== pinned)
									join(pinned)
								continue
							}

							// Dropped out of voice. Leaving yourself is not undone.
							if (Date.now() - leftAt < OWN_LEAVE_WINDOW) continue
							if (!cfg.reconnect) continue
							const target =
								cfg.moveToPinned && pinned ? pinned : cfg.lastChannelId
							if (!target) continue
							const wait =
								Math.max(0, Math.min(30, Number(cfg.rejoinDelay) || 0)) * 1000
							if (rejoinTimer) clearTimeout(rejoinTimer)
							rejoinTimer = setTimeout(() => {
								rejoinTimer = null
								// Only go back if I am still out of voice by then.
								if (connectedVoiceChannelId()) return
								join(target)
							}, wait)
						}
					} catch (error) {
						logger?.error?.('[DontControlMe] handler failed', error)
					}
					return payload
				},
			),
		)
		cleanup(() => {
			if (rejoinTimer) clearTimeout(rejoinTimer)
		})
		watchOwnLeave()
		logger?.log?.('[DontControlMe] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const [stored, set] = useSettings(api.jsonStorage, DEFAULTS)
		const settings: Settings = { ...DEFAULTS, ...stored }
		const pin = () => {
			const id = connectedVoiceChannelId() ?? viewedVoiceChannelId()
			if (id) set({ pinnedChannelId: id })
		}
		const pinned = settings.pinnedChannelId ?? null
		const last = settings.lastChannelId ?? null
		const rejoin = settings.reconnect !== false
		const delay = Number(settings.rejoinDelay ?? DEFAULTS.rejoinDelay)
		const canJoin = findVoiceActions() !== null
		const canUndoMute =
			findVoiceStateActions() !== null || findSelfMuteActions() !== null
		const parts = [
			rejoin ? 'rejoining after a drop' : null,
			settings.moveToPinned !== false ? 'returning to your pin' : null,
			settings.autoUnmute !== false ? 'undoing server mute' : null,
			settings.autoUndeafen !== false ? 'undoing server deafen' : null,
		].filter((part): part is string => part !== null)
		return (
			<Page>
				<Intro text="Don't Control Me puts you back where you were: it rejoins a call Discord dropped you out of, undoes a server mute or deafen, and returns you to the channel you pinned." />
				<Hero
					title={parts.length ? "Don't Control Me is on" : "Don't Control Me is off"}
					line={
						parts.length
							? `${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`
							: 'Nothing is undone until a switch below is turned on.'
					}
					tone={parts.length ? 'brand' : 'muted'}
				/>
				<Section title="When I get disconnected">
					<SwitchRow
						label="Rejoin when I get disconnected"
						subLabel="Discord drops you out of the call; this puts you back. Pressing Disconnect yourself is left alone."
						value={rejoin}
						onChange={reconnect => set({ reconnect })}
					/>
					<Row
						label="Wait before rejoining"
						subLabel={`${delay === 0 ? 'Straight away' : `${delay} ${plural(delay, 'second')}`} — a short pause reads as Discord reconnecting.`}
					/>
					<Choices
						value={String(delay)}
						options={DELAYS.map(item => ({
							value: String(item.value),
							label: item.label,
						}))}
						onChange={value => set({ rejoinDelay: Number(value) })}
					/>
				</Section>
				<Section title="Where you come back to">
					<SwitchRow
						label="Return to my pinned channel"
						subLabel="Off puts you back in the call you were dropped from."
						value={settings.moveToPinned !== false}
						onChange={moveToPinned => set({ moveToPinned })}
					/>
					<Row
						label="Rejoin to"
						subLabel={
							settings.moveToPinned !== false && pinned
								? voiceChannelName(pinned) + ' (pinned)'
								: last
									? voiceChannelName(last) + ' (last call)'
									: 'Nothing yet — join a voice channel once.'
						}
					/>
					<Row
						label="Pinned channel"
						subLabel={
							pinned
								? voiceChannelName(pinned)
								: 'None — join a voice channel, then pin it.'
						}
					/>
					<Row
						label={pinned ? 'Unpin channel' : 'Pin current channel'}
						subLabel={
							pinned
								? 'Clears the pin; the last call is still remembered.'
								: 'Pins the voice channel you are in now.'
						}
						onPress={() => (pinned ? set({ pinnedChannelId: null }) : pin())}
					/>
				</Section>
				<Section
					title="Server mute and deafen"
					description="Only where you have permission; a call that refuses is left alone."
				>
					<SwitchRow
						label="Undo server mute"
						subLabel="Comes back with your microphone on."
						value={settings.autoUnmute !== false}
						onChange={autoUnmute => set({ autoUnmute })}
					/>
					<SwitchRow
						label="Undo server deafen"
						subLabel="Comes back able to hear the call."
						value={settings.autoUndeafen !== false}
						onChange={autoUndeafen => set({ autoUndeafen })}
					/>
				</Section>
				<Section
					title="This build"
					description="What the client provides. A row that says missing explains a feature that cannot work here."
				>
					<Row
						label="Join action"
						subLabel={
							canJoin
								? 'Ready. Rejoining and moving back use it.'
								: 'Missing. Nothing can put you back in a call on this build.'
						}
					/>
					<Row
						label="Mute action"
						subLabel={
							canUndoMute
								? 'Ready. A server mute or deafen is undone while you are in the call.'
								: 'Missing. Server mute and deafen are left alone on this build.'
						}
					/>
				</Section>
			</Page>
		)
	},
})
