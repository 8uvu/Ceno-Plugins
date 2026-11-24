// Keywords, by cenotaph. A local watch on words rather than on people: when a
// message contains one, a toast names it, the channel and the author.
//
// Matching is whole-word and case-insensitive, so "cat" does not fire on
// "concatenate". Each word is throttled per channel, so a busy conversation
// cannot turn into a toast storm. Your own messages never fire, nothing is
// uploaded, and the word list never leaves this device.
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { onFluxEventDispatched } from '@valenced/discord/flux'
import { useState } from 'react'
import { Pressable, ScrollView, Text, TextInput } from 'react-native'
import { channelName, clip, selfId, userName } from '../../_shared/lookup'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord } from '../../_shared/types'
import type { DesignShim, JsonStorage, Logger } from '../../_shared/types'

interface Settings {
	enabled: boolean
	// One comma- or newline-separated list, edited on the page.
	words: string
}

const DEFAULTS: Settings = { enabled: true, words: '' }

// A ceiling, so a pasted list cannot become a scan of the whole chat per message.
const MAX_WORDS = 50
const MAX_WORD = 40
// One toast per word per channel in this window.
const GAP_MS = 60000
// How much of the message the toast quotes.
const QUOTE = 80

let logger: Logger | undefined
// The framework's storage type is looser than these settings, so only what is
// used is declared here and the cache is cast on read.
let live: {
	cache?: unknown
	set(patch: Partial<Settings>): Promise<unknown>
} | null = null
// word:channel -> when it last fired.
const lastFired = new Map<string, number>()

function current(): Settings {
	try {
		return ((live?.cache as Settings | undefined) ?? DEFAULTS) as Settings
	} catch {
		return DEFAULTS
	}
}

export function listOf(raw: string): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const part of raw.split(/[\n,]+/)) {
		const word = part.trim().toLowerCase()
		if (!word || word.length > MAX_WORD || seen.has(word)) continue
		seen.add(word)
		out.push(word)
		if (out.length >= MAX_WORDS) break
	}
	return out
}

function pattern(word: string): RegExp {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i')
}

export function matched(text: string, words: string[]): string[] {
	return words.filter(word => pattern(word).test(text))
}

function toast(text: string): void {
	try {
		ToastActionCreators.open('keywords', { text })
		return
	} catch {}
	try {
		ToastActionCreators.open({ key: 'keywords', content: text })
	} catch {}
}

// The words that both match and are past their throttle, marking each one as
// fired. Kept separate from the toast so a verifier can check the throttle.
function due(hits: string[], channelId: string, now: number): string[] {
	const out: string[] = []
	for (const word of hits) {
		const key = word + ':' + channelId
		const seen = lastFired.get(key) ?? 0
		if (now - seen < GAP_MS) continue
		lastFired.set(key, now)
		out.push(word)
	}
	// The map is small; this only stops it growing over a long session.
	if (lastFired.size > 200) {
		for (const [key, at] of lastFired) {
			if (now - at > GAP_MS) lastFired.delete(key)
		}
	}
	return out
}

function watch(payload: unknown): void {
	const settings = current()
	if (settings.enabled === false) return
	const words = listOf(typeof settings.words === 'string' ? settings.words : '')
	if (!words.length) return
	const message = asRecord(asRecord(payload).message)
	const author = asRecord(message.author)
	const me = selfId()
	if (me && author.id === me) return
	const content = typeof message.content === 'string' ? message.content : ''
	if (!content) return
	const hits = matched(content, words)
	if (!hits.length) return
	const channelId = message.channel_id == null ? '' : String(message.channel_id)
	const fired = due(hits, channelId, Date.now())
	if (!fired.length) return
	const where = channelId ? channelName(channelId) : 'a chat'
	const authorName =
		typeof author.globalName === 'string' && author.globalName
			? author.globalName
			: typeof author.global_name === 'string' && author.global_name
				? author.global_name
				: typeof author.username === 'string' && author.username
					? author.username
					: typeof author.id === 'string'
						? userName(author.id)
						: 'someone'
	const label =
		fired.length === 1
			? 'Keyword “' + fired[0] + '”'
			: 'Keywords “' + fired.join('”, “') + '”'
	const quote = clip(content, QUOTE)
	toast(
		label +
			' in ' +
			where +
			' — ' +
			authorName +
			(quote ? ': ' + quote : ''),
	)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		lastFired.clear()
		cleanup(
			// A listener only: the payload goes back untouched.
			onFluxEventDispatched('MESSAGE_CREATE', (payload: unknown) => {
				try {
					watch(payload)
				} catch (error) {
					logger?.warn?.('[Keywords] skipped a message', error)
				}
				return payload
			}),
		)
		logger?.log?.('[Keywords] started')
	},
	stop() {
		live = null
		lastFired.clear()
	},
	SettingsComponent({
		api,
	}: {
		api: { jsonStorage: JsonStorage<Settings> }
	}) {
		const settings = (api.jsonStorage.use() ?? DEFAULTS) as Settings
		const set = (patch: Partial<Settings>) => {
			Promise.resolve(api.jsonStorage.set(patch)).catch?.(() => {})
		}
		// React Native's TextInput on purpose: Discord's design input ignores
		// onChangeText on some builds, so a field built on it cannot be typed into.
		const [words, setWords] = useState(
			typeof settings.words === 'string' ? settings.words : '',
		)
		const update = (text: string) => {
			setWords(text)
			set({ words: text })
		}
		const list = listOf(words)
		const D = (Design ?? {}) as unknown as DesignShim
		const normal = token('TEXT_NORMAL')
		const muted = token('TEXT_MUTED')
		const field = {
			color: normal,
			backgroundColor: token('BACKGROUND_TERTIARY'),
			borderRadius: 8,
			padding: 8,
		}

		if (D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<D.TableRowGroup
						title="Keywords"
						description="Get a toast when a message contains one of your words. Whole words only, case does not matter."
					>
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Watch my words"
								subLabel="Off stops the toasts; the list is kept."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label={`Watching ${list.length} ${list.length === 1 ? 'word' : 'words'}`}
								subLabel="Separate them with commas or new lines."
							/>
						) : null}
						<TextInput
							style={field}
							value={words}
							onChangeText={update}
							placeholder="invoice, deadline, my name"
							placeholderTextColor={muted}
							multiline
						/>
						{D.TableRow ? (
							<D.TableRow
								label="Quiet by design"
								subLabel="One toast per word per channel a minute, and your own messages never fire."
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="Clear the list"
								subLabel="Removes every word from this device."
								onPress={() => update('')}
							/>
						) : null}
					</D.TableRowGroup>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: normal, fontWeight: 'bold' }}>Keywords</Text>
				<Text style={{ color: muted }}>
					Get a toast when a message contains one of your words.
				</Text>
				<Pressable
					accessibilityLabel="Watch my words"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Watch my words: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Text style={{ color: muted }}>
					Watching {list.length} {list.length === 1 ? 'word' : 'words'}. Separate
					them with commas or new lines.
				</Text>
				<TextInput
					style={field}
					value={words}
					onChangeText={update}
					placeholder="invoice, deadline, my name"
					placeholderTextColor={muted}
					multiline
				/>
				<Pressable
					accessibilityLabel="Clear the list"
					onPress={() => update('')}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>Clear the list</Text>
				</Pressable>
			</ScrollView>
		)
	},
})
