// Don't Control Me, by cenotaph. Puts you back when someone moves, mutes or
// drops you — and can be told exactly which of that you want.

import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched, Stores } from '@valenced/discord/flux'
import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { token } from '../../_shared/theme'
import type {
	DesignShim,
	JsonStorage,
	VoiceActions,
	VoiceStateActions,
} from '../../_shared/types'

type VoiceState = {
	userId?: string
	user_id?: string
	channelId?: string
	channel_id?: string
	mute?: boolean
	deaf?: boolean
}

type VoiceStatePayload = VoiceState & {
	voiceState?: VoiceState
	voiceStates?: VoiceState[]
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

function selfId(): string {
	try {
		return String(Stores.UserStore?.getCurrentUser?.()?.id ?? '')
	} catch {
		return ''
	}
}

function currentVoiceChannelId(): string | null {
	try {
		const selected =
			Stores.SelectedChannelStore ?? Stores.SelectedVoiceChannelStore
		const id =
			selected?.getVoiceChannelId?.() ?? selected?.getChannelId?.() ?? null
		return id ? String(id) : null
	} catch {
		return null
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

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		let warned = false
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

		cleanup(
			onFluxEventDispatched(
				'VOICE_STATE_UPDATE',
				(payload: VoiceStatePayload) => {
					try {
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
							const raw =
								vs?.channelId ?? vs?.channel_id ?? payload?.channelId ?? null
							const channelId = raw ? String(raw) : null
							const pinned = cfg.pinnedChannelId ?? null

							// In a call: remember it, and go back to the pin if moved out.
							if (channelId) {
								if (channelId !== cfg.lastChannelId) {
									jsonStorage.set({ lastChannelId: channelId })
								}
								if (pinned && cfg.moveToPinned && channelId !== pinned)
									join(pinned)
								continue
							}

							// Dropped out of voice.
							if (!cfg.reconnect) continue
							const target = pinned ?? cfg.lastChannelId
							if (!target) continue
							const wait =
								Math.max(0, Math.min(30, Number(cfg.rejoinDelay) || 0)) * 1000
							if (rejoinTimer) clearTimeout(rejoinTimer)
							rejoinTimer = setTimeout(() => {
								rejoinTimer = null
								// Only go back if I am still out of voice by then.
								if (currentVoiceChannelId()) return
								join(target)
							}, wait)
							// Server mute/deafen: undo while still in the call.
							const muted = vs?.mute ?? payload?.mute
							const deafened = vs?.deaf ?? payload?.deaf
							if ((muted && cfg.autoUnmute) || (deafened && cfg.autoUndeafen)) {
								const actions = findVoiceStateActions()
								if (actions) {
									guarded(target + ':state', () =>
										actions.updateVoiceState(target, {
											mute: muted && cfg.autoUnmute ? false : undefined,
											deaf: deafened && cfg.autoUndeafen ? false : undefined,
										}),
									)
								}
							}
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
		logger?.log?.('[DontControlMe] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings: Settings = { ...DEFAULTS, ...(api.jsonStorage.use() ?? {}) }
		const set = (patch: Partial<Settings>) => api.jsonStorage.set(patch)
		const pin = () => {
			const id = currentVoiceChannelId()
			if (id) api.jsonStorage.set({ pinnedChannelId: id })
		}
		const D = (Design ?? {}) as unknown as DesignShim
		const pinned = settings.pinnedChannelId ?? null
		const last = settings.lastChannelId ?? null
		if (D.TableRowGroup && D.TableSwitchRow) {
			const Row = D.TableRow ?? null
			const Button = D.Button ?? null
			const RadioGroup = D.TableRadioGroup ?? null
			const RadioRow = D.TableRadioRow ?? null
			return (
				<ScrollView style={{ paddingHorizontal: 16, paddingTop: 16, gap: 16 }}>
					<D.TableRowGroup title="Don't Control Me">
						<D.TableSwitchRow
							label="Rejoin when I get disconnected"
							subLabel="Discord drops you out of the call; this puts you back."
							value={settings.reconnect !== false}
							onValueChange={(v: boolean) => set({ reconnect: v })}
						/>
						{RadioGroup && RadioRow ? (
							<RadioGroup
								title="Wait before rejoining"
								value={String(settings.rejoinDelay ?? 2)}
								onChange={(value: string) =>
									set({ rejoinDelay: Number(value) })
								}
							>
								{DELAYS.map(delay => (
									<RadioRow
										key={delay.value}
										label={delay.label}
										value={String(delay.value)}
										subLabel={
											String(settings.rejoinDelay ?? 2) === String(delay.value)
												? 'Selected'
												: undefined
										}
									/>
								))}
							</RadioGroup>
						) : null}
						<D.TableSwitchRow
							label="Return to my pinned channel"
							value={settings.moveToPinned !== false}
							onValueChange={(v: boolean) => set({ moveToPinned: v })}
						/>
						<D.TableSwitchRow
							label="Undo server mute"
							value={settings.autoUnmute !== false}
							onValueChange={(v: boolean) => set({ autoUnmute: v })}
						/>
						<D.TableSwitchRow
							label="Undo server deafen"
							value={settings.autoUndeafen !== false}
							onValueChange={(v: boolean) => set({ autoUndeafen: v })}
						/>
						{Row ? (
							<Row
								label="Rejoin to"
								subLabel={
									pinned
										? pinned + ' (pinned)'
										: last
											? last + ' (last call)'
											: 'Nothing yet — join a voice channel once.'
								}
							/>
						) : null}
						{Row ? (
							<Row
								label="Pinned channel"
								subLabel={pinned ?? 'None — join a voice channel, then pin it.'}
							/>
						) : null}
						{Button ? (
							<Button
								text={pinned ? 'Unpin channel' : 'Pin current channel'}
								onPress={() =>
									pinned ? set({ pinnedChannelId: null }) : pin()
								}
							/>
						) : null}
					</D.TableRowGroup>
				</ScrollView>
			)
		}
		return (
			<View style={{ padding: 16 }}>
				<Text
					style={{
						color: token('TEXT_NORMAL'),
						fontWeight: 'bold',
						marginBottom: 8,
					}}
				>
					Don't Control Me
				</Text>
				<Text style={{ color: token('TEXT_MUTED'), marginBottom: 8 }}>
					Pinned: {pinned ?? 'none'} · Last call: {last ?? 'none'}
				</Text>
				<Text style={{ color: token('TEXT_MUTED'), marginBottom: 8 }}>
					Rejoin: {settings.reconnect !== false ? 'on' : 'off'} · Wait:{' '}
					{settings.rejoinDelay ?? 2}s
				</Text>
				<Pressable
					accessibilityLabel={pinned ? 'Unpin channel' : 'Pin current channel'}
					onPress={() => (pinned ? set({ pinnedChannelId: null }) : pin())}
					style={{
						padding: 12,
						backgroundColor: token('BACKGROUND_TERTIARY'),
						borderRadius: 8,
						marginBottom: 8,
					}}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						{pinned ? 'Unpin channel' : 'Pin current channel'}
					</Text>
				</Pressable>
				{(
					['reconnect', 'moveToPinned', 'autoUnmute', 'autoUndeafen'] as const
				).map(key => (
					<Pressable
						key={key}
						accessibilityLabel={key}
						onPress={() =>
							set({ [key]: !(settings[key] !== false) } as Partial<Settings>)
						}
						style={{ paddingVertical: 10 }}
					>
						<Text style={{ color: token('TEXT_NORMAL') }}>
							{key}: {settings[key] !== false ? 'on' : 'off'}
						</Text>
					</Pressable>
				))}
			</View>
		)
	},
})
