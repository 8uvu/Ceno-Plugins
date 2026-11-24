// Bookmarks, by cenotaph. Hold any message and keep it: the text, who wrote it
// and where, on this device. Nothing is uploaded and nothing is re-drawn into
// the chat; the page is the list.
//
// The saved text is kept as it was when it was saved, so an edit or a deletion
// afterwards does not change what you kept. Attachments are not copied, only
// mentioned, because a plugin has no business downloading someone's files.
import { ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { addMessageMenuRows } from '../../_shared/actionSheet'
import { ago, channelName, clip, userName } from '../../_shared/lookup'
import { settingsScroll, token } from '../../_shared/theme'
import { asRecord } from '../../_shared/types'
import type {
	DesignComponent,
	DesignShim,
	JsonStorage,
	Logger,
} from '../../_shared/types'

interface MessageLike {
	id?: string
	content?: string
	channel_id?: string
	attachments?: unknown[]
	author?: {
		id?: string
		username?: string
		globalName?: string
		global_name?: string
	}
}

interface Bookmark {
	// The message id, which is unique and makes saving twice a no-op.
	id: string
	channelId: string
	channelName: string
	authorName: string
	content: string
	at: number
}

interface Settings {
	enabled: boolean
	items: Bookmark[]
}

const DEFAULTS: Settings = { enabled: true, items: [] }

// A ceiling, so the storage file cannot grow without end.
const MAX_ITEMS = 500
// Saved text is clipped: a bookmark is a reminder of a message, not an archive.
const PREVIEW = 140

interface RowComponent {
	(props: Record<string, unknown>): unknown
	Group?: DesignComponent
	Icon?: DesignComponent
}

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

function itemsOf(settings: Settings): Bookmark[] {
	return Array.isArray(settings.items) ? settings.items : []
}

function toast(text: string): void {
	try {
		ToastActionCreators.open('bookmarks', { text })
		return
	} catch {}
	try {
		ToastActionCreators.open({ key: 'bookmarks', content: text })
	} catch {}
}

function iconFor(name: string): unknown {
	try {
		return lookupGeneratedIconComponent(name)
	} catch {
		return undefined
	}
}

function authorOf(message: MessageLike): string {
	const author = message.author
	const name = author?.globalName ?? author?.global_name ?? author?.username
	if (typeof name === 'string' && name) return name
	return typeof author?.id === 'string' ? userName(author.id) : ''
}

function bodyOf(message: MessageLike): string {
	const text = clip(
		typeof message.content === 'string' ? message.content : '',
		PREVIEW,
	)
	if (text) return text
	const files = Array.isArray(message.attachments)
		? message.attachments.length
		: 0
	if (files === 1) return '(one attachment)'
	if (files > 1) return `(${files} attachments)`
	return '(no text)'
}

// ─── Saving and removing ─────────────────────────────────────────────────────

function toggle(message: MessageLike): void {
	const settings = current()
	if (settings.enabled === false) {
		toast('Bookmarks are switched off in their settings.')
		return
	}
	const id = typeof message.id === 'string' ? message.id : ''
	if (!id) return
	const items = itemsOf(settings)
	if (items.some(item => item.id === id)) {
		write({ items: items.filter(item => item.id !== id) })
		toast('Removed from bookmarks.')
		return
	}
	const channelId =
		typeof message.channel_id === 'string' ? message.channel_id : ''
	const bookmark: Bookmark = {
		id,
		channelId,
		channelName: channelId ? channelName(channelId) : '',
		authorName: authorOf(message),
		content: bodyOf(message),
		at: Date.now(),
	}
	write({ items: [bookmark, ...items].slice(0, MAX_ITEMS) })
	toast('Saved to bookmarks.')
}

function drop(id: string): void {
	const settings = current()
	const items = itemsOf(settings)
	if (!items.some(item => item.id === id)) return
	write({ items: items.filter(item => item.id !== id) })
	toast('Removed from bookmarks.')
}

// A row tap is easy to hit by accident while scrolling, so removing one asks
// first, with the system dialog every build has.
function askToDrop(item: Bookmark): void {
	try {
		Alert.alert(
			'Remove this bookmark?',
			`“${item.content}”\n\n${item.authorName || 'Someone'}${item.channelName ? ' in ' + item.channelName : ''}`,
			[
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Remove',
					style: 'destructive',
					onPress: () => drop(item.id),
				},
			],
			{ cancelable: true },
		)
	} catch {
		toast('This build could not show a confirmation.')
	}
}

// ─── The message menu ────────────────────────────────────────────────────────

function menuRows(message: MessageLike): unknown[] {
	const design = asRecord(Design)
	const Row = design.ActionSheetRow as RowComponent | undefined
	if (typeof Row !== 'function') return []
	const id = typeof message.id === 'string' ? message.id : ''
	if (!id) return []
	const settings = current()
	// Switched off takes the row away, as the page says it does.
	if (settings.enabled === false) return []
	const saved = itemsOf(settings).some(item => item.id === id)
	const Group = Row.Group
	const Icon = Row.Icon
	const icon = (): unknown => {
		if (typeof Icon !== 'function') return undefined
		const component = iconFor('BookmarkIcon')
		return component ? <Icon IconComponent={component} /> : undefined
	}
	const row = (
		<Row
			key="bookmarks-toggle"
			label={saved ? 'Remove this bookmark' : 'Save this message'}
			icon={icon()}
			onPress={() => toggle(message)}
		/>
	)
	if (typeof Group === 'function') return [<Group key="bookmarks">{row}</Group>]
	return [row]
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DEFAULTS },
	start({ cleanup, jsonStorage, logger: pluginLogger }) {
		logger = pluginLogger
		live = jsonStorage as unknown as typeof live
		cleanup(
			addMessageMenuRows(props => {
				const message = asRecord(props.message) as MessageLike
				return menuRows(message)
			}, logger),
		)
		logger?.log?.('[Bookmarks] started')
	},
	stop() {
		live = null
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
		const items = itemsOf(settings)
		const now = Date.now()
		const D = (Design ?? {}) as unknown as DesignShim
		const normal = token('TEXT_NORMAL')
		const muted = token('TEXT_MUTED')

		const plain = (key: string, label: string, subLabel?: string) => (
			<View key={key} style={{ paddingVertical: 6 }}>
				<Text style={{ color: normal }}>{label}</Text>
				{subLabel ? <Text style={{ color: muted }}>{subLabel}</Text> : null}
			</View>
		)

		const row = (key: string, label: string, subLabel?: string) =>
			D.TableRow ? (
				<D.TableRow key={key} label={label} subLabel={subLabel} />
			) : (
				plain(key, label, subLabel)
			)

		if (D.TableRowGroup) {
			return (
				<ScrollView style={settingsScroll}>
					<D.TableRowGroup
						title="Bookmarks"
						description="Hold a message and choose Save this message. The text is kept on this device, as it was when you saved it."
					>
						{D.TableSwitchRow ? (
							<D.TableSwitchRow
								label="Offer the row in the message menu"
								subLabel="Off stops new saves and removes the row; what is already saved stays."
								value={settings.enabled !== false}
								onValueChange={(v: boolean) => set({ enabled: v })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label={`Remove every bookmark (${items.length})`}
								subLabel="Deletes them from this device."
								onPress={() => set({ items: [] })}
							/>
						) : null}
						{D.TableRow ? (
							<D.TableRow
								label="What is kept"
								subLabel="The text, its author, the channel and the time. Attachments are only named, never downloaded."
							/>
						) : null}
					</D.TableRowGroup>
					<D.TableRowGroup
						title={
							items.length === 0 ? 'Nothing saved' : `Saved (${items.length})`
						}
						description={
							items.length === 0
								? undefined
								: 'Newest first. Tap one to remove it.'
						}
					>
						{items.length === 0
							? row(
									'empty',
									'Nothing saved yet.',
									'Hold a message and choose Save this message.',
								)
							: items.map(item =>
									D.TableRow ? (
										<D.TableRow
											key={item.id}
											label={`${item.authorName || 'Someone'}${item.channelName ? ' · ' + item.channelName : ''}`}
											subLabel={`“${item.content}” · ${ago(item.at, now)}`}
											onPress={() => askToDrop(item)}
										/>
									) : (
										<Pressable
											key={item.id}
											accessibilityLabel={`Remove ${item.content}`}
											onPress={() => askToDrop(item)}
											style={{ paddingVertical: 6 }}
										>
											<Text style={{ color: normal }}>
												{item.authorName || 'Someone'}
												{item.channelName ? ' · ' + item.channelName : ''}
											</Text>
											<Text style={{ color: muted }}>
												“{item.content}” · {ago(item.at, now)}
											</Text>
										</Pressable>
									),
								)}
					</D.TableRowGroup>
				</ScrollView>
			)
		}

		// Builds without the design rows still get a readable page.
		return (
			<ScrollView style={settingsScroll}>
				<Text style={{ color: normal, fontWeight: 'bold' }}>Bookmarks</Text>
				<Text style={{ color: muted }}>
					Hold a message and choose Save this message.
				</Text>
				<Pressable
					accessibilityLabel="Offer the row in the message menu"
					onPress={() => set({ enabled: !(settings.enabled !== false) })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Offer the row: {settings.enabled !== false ? 'on' : 'off'}
					</Text>
				</Pressable>
				<Pressable
					accessibilityLabel="Remove every bookmark"
					onPress={() => set({ items: [] })}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal }}>
						Remove every bookmark ({items.length})
					</Text>
				</Pressable>
				{items.length === 0 ? (
					<Text style={{ color: muted, marginTop: 8 }}>Nothing saved yet.</Text>
				) : (
					items.map(item => (
						<Pressable
							key={item.id}
							accessibilityLabel={`Remove ${item.content}`}
							onPress={() => askToDrop(item)}
							style={{ paddingVertical: 6 }}
						>
							<Text style={{ color: normal }}>
								{item.authorName || 'Someone'}
								{item.channelName ? ' · ' + item.channelName : ''}
							</Text>
							<Text style={{ color: muted }}>
								“{item.content}” · {ago(item.at, now)}
							</Text>
						</Pressable>
					))
				)}
			</ScrollView>
		)
	},
})
