// Clean URLs, by cenotaph. Strips tracking parameters from links in chat.

import { onFluxEventDispatched } from '@valenced/discord/flux'
import { useState } from 'react'
import {
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
import type { JsonStorage } from '../../_shared/types'

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
		const [settings, set] = useSettings(api.jsonStorage, DEFAULTS)
		const on = settings.enabled !== false
		// Also kept in local state, so typing never waits on a storage write.
		const [extra, setExtra] = useState(settings.extra ?? '')
		const updateExtra = (text: string) => {
			setExtra(text)
			set({ extra: text })
		}
		return (
			<Page>
				<Intro text="Clean URLs takes the tracking out of a link as its message is created or edited: utm_source, fbclid, gclid and the rest of the known list." />
				<Hero
					title={on ? 'Clean URLs is on' : 'Clean URLs is off'}
					line={
						on
							? 'Links lose their tracking parameters before the message reaches the chat.'
							: 'Messages are left exactly as written.'
					}
					tone={on ? 'brand' : 'muted'}
					action={
						on
							? { label: 'Turn off', onPress: () => set({ enabled: false }) }
							: { label: 'Turn on', onPress: () => set({ enabled: true }) }
					}
				/>
				<Section
					title="Links"
					description="One switch for every link; the field adds to the parameters already known."
				>
					<SwitchRow
						label="Strip tracking parameters"
						subLabel="Removes utm_*, fbclid, gclid and friends from links."
						value={on}
						onChange={enabled => set({ enabled })}
					/>
					<Field
						label="Extra parameters"
						value={extra}
						onChange={updateExtra}
						placeholder="si, igsh, mkt_tok"
						description="Comma-separated. Case does not matter."
					/>
				</Section>
				<Section title="What it leaves alone">
					<Row
						label="Everything it does not recognise"
						subLabel="The address, the path and every other parameter stay exactly as written."
					/>
					<Note text="Nothing leaves the device: the message text is read as Discord dispatches it." />
				</Section>
			</Page>
		)
	},
})
