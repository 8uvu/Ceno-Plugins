// TypingTally, by cenotaph. Counts how often you start typing per channel today.
import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { token } from '../../_shared/theme'
import type { DesignShim, JsonStorage } from '../../_shared/types'

type TypingPayload = { channelId?: string | number }

interface Settings {
	enabled: boolean
	day: string
	counts: Record<string, number>
}

const DEFAULTS: Settings = { enabled: true, day: '', counts: {} }
const SHOW = 20

export function dayKey(at: number): string {
	const d = new Date(at)
	const month = String(d.getMonth() + 1).padStart(2, '0')
	const date = String(d.getDate()).padStart(2, '0')
	return d.getFullYear() + '-' + month + '-' + date
}

// Starts a fresh tally when the day changes, so counts only ever cover today.
export function tally(
	current: Settings,
	channelId: string,
	at: number,
): Partial<Settings> {
	const today = dayKey(at)
	const base = current.day === today && current.counts ? current.counts : {}
	return {
		day: today,
		counts: { ...base, [channelId]: (base[channelId] ?? 0) + 1 },
	}
}

export function topChannels(
	counts: Record<string, number>,
): [string, number][] {
	return Object.entries(counts ?? {})
		.sort((a, b) => b[1] - a[1])
		.slice(0, SHOW)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		cleanup(
			// A listener only: the payload goes back untouched.
			onFluxEventDispatched(
				'TYPING_START_LOCAL',
				(payload: TypingPayload | null) => {
					const current = jsonStorage.cache ?? DEFAULTS
					if (
						current.enabled === false ||
						!payload ||
						typeof payload !== 'object'
					)
						return payload
					const channelId =
						payload.channelId == null ? '' : String(payload.channelId)
					if (!channelId) return payload
					Promise.resolve(
						jsonStorage.set(tally(current, channelId, Date.now())),
					).catch?.(() => {})
					return payload
				},
			),
		)
		logger?.log?.('[TypingTally] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings = api.jsonStorage.use() ?? DEFAULTS
		const set = (patch: Partial<Settings>) =>
			api.jsonStorage.set(patch).catch?.(() => {})
		const today = dayKey(Date.now())
		const counts = settings.day === today ? (settings.counts ?? {}) : {}
		const top = topChannels(counts)
		const total = top.reduce((sum, [, n]) => sum + n, 0)
		const D = (Design ?? {}) as unknown as DesignShim
		// Design rows are missing on some builds; fall back to plain text.
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
					<D.TableRowGroup title="TypingTally">
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Count my typing"
								subLabel="Counts today's typing per channel. Stored on this device only."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="Reset today"
								onPress={() => set({ day: today, counts: {} })}
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup title={`Today: ${total} starts`}>
						{top.length === 0
							? row('empty', 'Nothing counted today.')
							: top.map(([channel, n]) =>
									row(
										channel,
										'Channel ' + channel,
										n + (n === 1 ? ' start' : ' starts'),
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
					TypingTally
				</Text>
				<Pressable
					accessibilityLabel="Count my typing"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>
						Count my typing: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Reset today"
					onPress={() => set({ day: today, counts: {} })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: token('TEXT_NORMAL') }}>Reset today</Text>
				</Pressable>
				<Text style={{ color: token('TEXT_NORMAL'), marginTop: 8 }}>
					Today: {total} starts
				</Text>
				{top.length === 0 ? (
					<Text style={{ color: token('TEXT_MUTED'), marginTop: 8 }}>
						Nothing counted today.
					</Text>
				) : (
					top.map(([channel, n]) => (
						<Text key={channel} style={{ color: token('TEXT_NORMAL') }}>
							{'Channel ' + channel + ' — ' + n}
						</Text>
					))
				)}
			</ScrollView>
		)
	},
})
