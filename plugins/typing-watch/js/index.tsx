// TypingWatch, by cenotaph. Keeps the last few typing indicators you missed.
import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { token } from '../../_shared/theme'
import type { DesignShim, JsonStorage } from '../../_shared/types'

type TypingPayload = { channelId?: string | number; userId?: string | number }

interface Entry {
	channelId: string
	userId: string
	at: number
}

interface Settings {
	enabled: boolean
	recent: Entry[]
}

const DEFAULTS: Settings = { enabled: true, recent: [] }
const KEEP = 20

export function ago(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000))
	if (seconds < 60) return seconds + 's ago'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return minutes + 'm ago'
	const hours = Math.round(minutes / 60)
	if (hours < 24) return hours + 'h ago'
	return Math.round(hours / 24) + 'd ago'
}

// Newest first, one row per person and channel: the same person typing again in
// the same channel moves their row up rather than filling the list.
export function remember(recent: Entry[], entry: Entry): Entry[] {
	const rest = (Array.isArray(recent) ? recent : []).filter(
		item =>
			!(item?.channelId === entry.channelId && item?.userId === entry.userId),
	)
	return [entry, ...rest].slice(0, KEEP)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		cleanup(
			// A listener, not a gate: the payload goes back untouched so the
			// indicator still shows for everyone.
			onFluxEventDispatched('TYPING_START', (payload: TypingPayload | null) => {
				const current = jsonStorage.cache ?? DEFAULTS
				if (
					current.enabled === false ||
					!payload ||
					typeof payload !== 'object'
				)
					return payload
				const channelId =
					payload.channelId == null ? '' : String(payload.channelId)
				const userId = payload.userId == null ? '' : String(payload.userId)
				if (!channelId || !userId) return payload
				const entry: Entry = { channelId, userId, at: Date.now() }
				Promise.resolve(
					jsonStorage.set({ recent: remember(current.recent ?? [], entry) }),
				).catch?.(() => {})
				return payload
			}),
		)
		logger?.log?.('[TypingWatch] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings = api.jsonStorage.use() ?? DEFAULTS
		const set = (patch: Partial<Settings>) =>
			api.jsonStorage.set(patch).catch?.(() => {})
		const recent = Array.isArray(settings.recent) ? settings.recent : []
		const now = Date.now()
		const D = (Design ?? {}) as unknown as DesignShim
		// Design.TableRow is missing on some builds. Rendering it anyway throws
		// "element type is invalid" and takes the whole page down, so an absent
		// row falls back to plain text with an explicit color.
		const row = (key: string, label: string, subLabel?: string) =>
			D.TableRow ? (
				<D.TableRow key={key} label={label} subLabel={subLabel} />
			) : (
				<View key={key} style={{ paddingVertical: 6 }}>
					<Text style={{ color: token('TEXT_NORMAL') }}>{label}</Text>
					{subLabel ? (
						<Text style={{ color: token('TEXT_MUTED') }}>{subLabel}</Text>
					) : null}
				</View>
			)
		if (D.TableRowGroup) {
			return (
				<ScrollView style={{ paddingHorizontal: 16, paddingTop: 16, gap: 16 }}>
					<D.TableRowGroup title="TypingWatch">
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Remember who types"
								subLabel="Keeps the last 20 people who started typing."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="Clear the list"
								onPress={() => set({ recent: [] })}
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup title={`Recent (${recent.length})`}>
						{recent.length === 0
							? row('empty', 'Nobody has typed yet.')
							: recent.map((entry: Entry) =>
									row(
										entry.channelId + ':' + entry.userId,
										entry.userId + ' in ' + entry.channelId,
										ago(entry.at, now),
									),
								)}
					</D.TableRowGroup>
				</ScrollView>
			)
		}
		return (
			<ScrollView style={{ padding: 16 }}>
				<Text
					style={{
						color: token('TEXT_NORMAL'),
						fontWeight: 'bold',
						marginBottom: 8,
					}}
				>
					TypingWatch
				</Text>
				<Pressable
					accessibilityLabel="Remember who types"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						Remember who types: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Clear the list"
					onPress={() => set({ recent: [] })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						Clear the list ({recent.length})
					</Text>
				</Pressable>
				{recent.length === 0 ? (
					<Text style={{ color: token('TEXT_MUTED'), marginTop: 8 }}>
						Nobody has typed yet.
					</Text>
				) : (
					recent.map((entry: Entry) => (
						<Text
							key={entry.channelId + ':' + entry.userId}
							style={{ color: token('TEXT_NORMAL') }}
						>
							{entry.userId +
								' in ' +
								entry.channelId +
								' — ' +
								ago(entry.at, now)}
						</Text>
					))
				)}
			</ScrollView>
		)
	},
})
