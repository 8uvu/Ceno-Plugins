// The shapes this plugin needs from Discord's JavaScript runtime. They are
// deliberately narrow: only the fields the plugins actually read, so a client
// update that drops something shows up as a type error instead of `undefined`
// at runtime.

export type Snowflake = string

export interface DiscordUser {
	id: Snowflake
	username?: string
	discriminator?: string
	globalName?: string
	avatar?: string | null
	bot?: boolean
}

export interface DiscordChannel {
	id: Snowflake
	name?: string
	guild_id?: Snowflake
	guildId?: Snowflake
	recipients?: Array<DiscordUser | Snowflake>
	rawRecipients?: Array<DiscordUser | Snowflake>
}

export interface DiscordAttachment {
	id: string
	filename: string
	size: number
	url: string
	proxy_url: string
	width?: number
	height?: number
	content_type?: string
}

export interface DiscordEmbedImage {
	url: string
	proxy_url?: string
}

export interface DiscordEmbed {
	title?: string
	description?: string
	image?: DiscordEmbedImage
}

export interface DiscordMessageAuthor {
	id: string
	username: string
	discriminator: string
	avatar: string | null
	global_name: string
	bot: boolean
}

export interface DiscordMessageReference {
	channel_id: Snowflake
	message_id: Snowflake
}

export interface DiscordReferencedMessage {
	id: Snowflake
	channel_id: Snowflake
	content: string
	author: DiscordMessageAuthor
	type: number
}

export interface DiscordCall {
	participants: Snowflake[]
	ended_timestamp: string
	duration?: number
}

export interface DiscordMessage {
	id: Snowflake
	channel_id: Snowflake
	author: DiscordMessageAuthor
	content: string
	timestamp: string
	edited_timestamp: string | null
	tts: boolean
	mention_roles: Snowflake[]
	mentions: DiscordUser[]
	attachments: DiscordAttachment[]
	embeds: DiscordEmbed[]
	components: unknown[]
	pinned: boolean
	flags: number
	nonce: string
	type: number
	message_reference?: DiscordMessageReference
	referenced_message?: DiscordReferencedMessage
	call?: DiscordCall
}

export interface MessageCreatePayload {
	type: 'MESSAGE_CREATE'
	channelId: Snowflake
	message: DiscordMessage
	optimistic: boolean
	isPushNotification: boolean
}

export interface MessageDeletePayload {
	type: 'MESSAGE_DELETE'
	channelId: Snowflake
	id: Snowflake
}

export interface ReactionAddPayload {
	type: 'MESSAGE_REACTION_ADD'
	channelId: Snowflake
	messageId: Snowflake
	userId: Snowflake
	emoji: { name: string; id: null; animated: boolean }
}

export type DispatchEvent =
	| MessageCreatePayload
	| MessageDeletePayload
	| ReactionAddPayload
	| { type: string; [key: string]: unknown }

export interface DispatcherLike {
	dispatch(event: DispatchEvent): void
	subscribe(
		event: string,
		listener: (payload: Record<string, unknown>) => void,
	): () => void
}

export interface StoreLike {
	getCurrentUser?(): DiscordUser | null
	getUser?(id: Snowflake): DiscordUser | null
	getChannel?(id: Snowflake): DiscordChannel | null
	getChannelId?(): Snowflake | null
	getSelectedChannelId?(): Snowflake | null
	getLastSelectedChannelId?(): Snowflake | null
	getMembers?(
		guildId: Snowflake,
	): Record<string, { user?: DiscordUser; userId?: Snowflake }>
}

export interface ModuleWithType {
	type?: unknown
	default?: unknown
	displayName?: string
	name?: string
}

export interface VoiceActions {
	selectVoiceChannel(channelId: Snowflake): void
}

export interface VoiceStateActions {
	updateVoiceState(
		channelId: Snowflake,
		state: { mute?: boolean; deaf?: boolean },
	): void
}

export interface Logger {
	log?(...args: unknown[]): void
	warn?(...args: unknown[]): void
	error?(...args: unknown[]): void
}

export type JsonStorage<T> = {
	cache: T | null
	use(): T
	get(): T
	set(patch: Partial<T>): Promise<void>
	subscribe(listener: (value: T) => void): () => void
}

// The Discord design components a plugin may draw its settings with. Every
// entry is optional, because a build is allowed not to ship one.
export type DesignComponent = (props: Record<string, unknown>) => unknown

export interface DesignShim {
	TableRowGroup?: DesignComponent
	TableRow?: DesignComponent
	TableSwitchRow?: DesignComponent
	TableRadioGroup?: DesignComponent
	TableRadioRow?: DesignComponent
	AlertModal?: DesignComponent
	AlertActionButton?: DesignComponent
	Stack?: DesignComponent
	Text?: DesignComponent
	Button?: DesignComponent
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {}
}

export function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string'
		? value
		: value === undefined || value === null
			? fallback
			: String(value)
}

export function errorMessage(error: unknown): string {
	if (isRecord(error) && typeof error.message === 'string') return error.message
	return error instanceof Error ? error.message : 'unknown error'
}
