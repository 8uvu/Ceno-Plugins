// Clean URLs, by cenotaph. Strips tracking parameters from links in chat.

import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { useState } from 'react'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { settingsScroll, token } from '../../_shared/theme'
import type { DesignShim, JsonStorage } from '../../_shared/types'

interface Settings {
	enabled: boolean
	extra: string
}

const DEFAULTS: Settings = { enabled: true, extra: '' }

const TRACKING = new Set([
	'fbclid',
	'gclid',
	'gclsrc',
	'dclid',
	'gbraid',
	'wbraid',
	'msclkid',
	'twclid',
	'ttclid',
	'yclid',
	'igshid',
	'igsh',
	'si',
	'mkt_tok',
	'mc_eid',
	'mc_cid',
	'_hsenc',
	'_hsmi',
	'vero_conv',
	'vero_id',
	'spm',
	'scm',
	'tt_from',
	'trk_contact',
	'trk_msg',
	'trk_module',
	'trk_sid',
	'rb_clickid',
	'oly_anon_id',
	'oly_enc_id',
	'wickedid',
	'trk',
])
const PREFIXES = ['utm_', 'fb_', 'ga_', 'mc_', 'matomo_', 'pk_', 'mtm_']

function splitList(raw: string): Set<string> {
	return new Set(
		raw
			.split(/[\s,]+/)
			.map(s => s.trim().toLowerCase())
			.filter(Boolean),
	)
}

function isTracked(key: string, extra: Set<string>): boolean {
	if (TRACKING.has(key) || extra.has(key)) return true
	return PREFIXES.some(p => key.startsWith(p))
}

function cleanUrl(url: string, extra: Set<string>): string {
	const schemeEnd = url.indexOf('://')
	const hostStart =
		schemeEnd === -1 ? (url.startsWith('//') ? 2 : 0) : schemeEnd + 3
	const afterHost = url.indexOf('/', hostStart)
	const authority = afterHost === -1 ? url : url.slice(0, afterHost)
	const rest = afterHost === -1 ? '' : url.slice(afterHost)
	const queryStart = rest.indexOf('?')
	if (queryStart === -1) return url
	const hashStart = rest.indexOf('#')
	const path = rest.slice(0, queryStart)
	const queryEnd = hashStart === -1 ? rest.length : hashStart
	const hashPart = hashStart === -1 ? '' : rest.slice(hashStart)
	const keep: string[] = []
	for (const pair of rest.slice(queryStart + 1, queryEnd).split('&')) {
		if (!pair) continue
		const eq = pair.indexOf('=')
		const rawKey = eq === -1 ? pair : pair.slice(0, eq)
		let key = rawKey
		try {
			key = decodeURIComponent(rawKey)
		} catch {}
		if (!isTracked(key.toLowerCase(), extra)) keep.push(pair)
	}
	return authority + path + (keep.length ? '?' + keep.join('&') : '') + hashPart
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

export function cleanText(text: string, extraRaw: string): string {
	if (!text || typeof text !== 'string' || !text.includes('?')) return text
	const extra = splitList(extraRaw)
	return text.replace(URL_RE, m => {
		const trimmed = m.match(/[.,;:!?]+$/)
		const body = trimmed ? m.slice(0, m.length - trimmed[0].length) : m
		return cleanUrl(body, extra) + (trimmed ? trimmed[0] : '')
	})
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger }) {
		const scrub = (payload: { message?: { content?: string } } | null) => {
			try {
				const cfg = jsonStorage.cache ?? DEFAULTS
				if (cfg.enabled === false) return payload
				const message = payload?.message
				if (message && typeof message.content === 'string') {
					const out = cleanText(message.content, String(cfg.extra ?? ''))
					if (out !== message.content) message.content = out
				}
			} catch (error) {
				logger?.error?.('[CleanURLs] scrub failed', error)
			}
			return payload
		}
		cleanup(onFluxEventDispatched('MESSAGE_CREATE', scrub))
		cleanup(onFluxEventDispatched('MESSAGE_UPDATE', scrub))
		logger?.log?.('[CleanURLs] started')
	},
	SettingsComponent({ api }: { api: { jsonStorage: JsonStorage<Settings> } }) {
		const settings = api.jsonStorage.use() ?? DEFAULTS
		const set = (patch: Partial<Settings>) => api.jsonStorage.set(patch)
		const D = (Design ?? {}) as unknown as DesignShim
		// React Native's TextInput on purpose: Discord's design input ignores
		// onChangeText on 352.x, so a field built on it cannot be typed into.
		const [extra, setExtra] = useState(settings.extra ?? '')
		const updateExtra = (t: string) => {
			setExtra(t)
			set({ extra: t })
		}
		if (D.TableRowGroup && D.TableSwitchRow) {
			return (
				<D.TableRowGroup title="Clean URLs">
					<D.TableSwitchRow
						label="Strip tracking parameters"
						subLabel="Removes utm_*, fbclid, gclid and friends from links."
						value={settings.enabled !== false}
						onValueChange={(v: boolean) => set({ enabled: v })}
					/>
					<View style={{ marginVertical: 4 }}>
						<Text style={{ color: token('TEXT_MUTED'), marginBottom: 2 }}>
							Extra parameters (comma-separated)
						</Text>
						<TextInput
							style={{
								color: token('TEXT_NORMAL'),
								backgroundColor: token('BACKGROUND_TERTIARY'),
								borderRadius: 8,
								padding: 8,
							}}
							value={extra}
							onChangeText={updateExtra}
						/>
					</View>
				</D.TableRowGroup>
			)
		}
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: token('TEXT_NORMAL'), fontWeight: 'bold' }}>
					Clean URLs
				</Text>
				<Text style={{ color: token('TEXT_MUTED') }}>
					Removes tracking parameters from links.
				</Text>
				<Text style={{ color: token('TEXT_NORMAL') }}>
					Enabled: {settings.enabled !== false ? 'on' : 'off'}
				</Text>
				<Text style={{ color: token('TEXT_MUTED') }}>
					Extra parameters (comma-separated):
				</Text>
				<TextInput
					style={{
						color: token('TEXT_NORMAL'),
						backgroundColor: token('BACKGROUND_TERTIARY'),
						borderRadius: 8,
						padding: 8,
					}}
					value={extra}
					onChangeText={updateExtra}
				/>
			</ScrollView>
		)
	},
})
