// The page kit: one place where a settings page is put together, so every
// plugin in this repository draws the same way and a missing component costs a
// row's decoration, never the page.
//
// Discord's own components are looked up on every render, never at module scope:
// they are lazy proxies, and reading a missing one can throw. When a component
// is missing the kit falls back to React Native with theme tokens, so the page
// stays readable on any build and in any theme.
import { Design } from '@valenced/discord/design'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { settingsScroll, token } from '../theme'
import { asRecord } from '../types'

type Props = Record<string, unknown>
type Component = (props: Props) => unknown

export function component(name: string): Component | null {
	try {
		const value = (asRecord(Design) as Record<string, unknown>)[name]
		return typeof value === 'function' ? (value as Component) : null
	} catch {
		return null
	}
}

function muted() {
	return token('TEXT_MUTED')
}

function normal() {
	return token('TEXT_NORMAL')
}

// ─── The page ────────────────────────────────────────────────────────────────

export function Page({ children }: { children?: unknown }) {
	return (
		<ScrollView style={settingsScroll} keyboardShouldPersistTaps="handled">
			{children}
		</ScrollView>
	)
}

/** The opening paragraph, on a card when the build has one. */
export function Intro({ text }: { text: string }) {
	const Card = component('Card')
	const Stack = component('Stack')
	const DText = component('Text')
	if (Card && Stack && DText) {
		return (
			<Card>
				<Stack spacing={8}>
					<DText variant="text-sm/normal" color="text-muted">
						{text}
					</DText>
				</Stack>
			</Card>
		)
	}
	return (
		<Text style={{ color: muted(), fontSize: 14, lineHeight: 20 }}>{text}</Text>
	)
}

/**
 * A titled group. `title` is the small heading Discord draws above its rows;
 * the plain fallback draws the same heading as text.
 */
export function Section({
	title,
	description,
	children,
}: {
	title?: string
	description?: string
	children?: unknown
}) {
	const Group = component('TableRowGroup')
	if (Group) {
		return (
			<Group title={title} description={description}>
				{children}
			</Group>
		)
	}
	return (
		<View style={{ marginBottom: 20, gap: 6 }}>
			{title ? (
				<Text
					style={{
						color: muted(),
						fontSize: 12,
						fontWeight: '600',
						textTransform: 'uppercase',
					}}
				>
					{title}
				</Text>
			) : null}
			{description ? (
				<Text style={{ color: muted(), fontSize: 13 }}>{description}</Text>
			) : null}
			{children}
		</View>
	)
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface RowOptions {
	// Accepted so a list of rows can be keyed where it is built.
	key?: string | number
	label: string
	subLabel?: string
	onPress?: () => void
	// Discord draws the chevron itself; with the plain fallback a pressable row
	// is enough, so the flag is only passed to the real row.
	arrow?: boolean
	trailing?: unknown
	danger?: boolean
	icon?: unknown
}

export function Row({ label, subLabel, onPress, arrow, trailing, danger, icon }: RowOptions) {
	const TableRow = component('TableRow')
	if (TableRow) {
		return (
			<TableRow
				label={label}
				subLabel={subLabel}
				onPress={onPress}
				arrow={arrow ?? Boolean(onPress)}
				trailing={trailing}
				variant={danger ? 'danger' : undefined}
				icon={icon}
			/>
		)
	}
	const body = (
		<>
			<Text style={{ color: danger ? token('TEXT_DANGER') ?? normal() : normal() }}>
				{label}
			</Text>
			{subLabel ? (
				<Text style={{ color: muted(), fontSize: 13, marginTop: 2 }}>
					{subLabel}
				</Text>
			) : null}
			{trailing as never}
		</>
	)
	if (!onPress) return <View style={{ paddingVertical: 8 }}>{body}</View>
	return (
		<Pressable
			accessibilityLabel={label}
			onPress={onPress}
			style={{ paddingVertical: 8 }}
		>
			{body}
		</Pressable>
	)
}

export function SwitchRow({
	label,
	subLabel,
	value,
	onChange,
	disabled,
}: {
	label: string
	subLabel?: string
	value: boolean
	onChange: (value: boolean) => void
	disabled?: boolean
}) {
	const TableSwitchRow = component('TableSwitchRow')
	if (TableSwitchRow) {
		return (
			<TableSwitchRow
				label={label}
				subLabel={subLabel}
				value={value}
				disabled={disabled}
				onValueChange={onChange}
			/>
		)
	}
	return (
		<Pressable
			accessibilityLabel={label}
			disabled={disabled}
			onPress={() => onChange(!value)}
			style={{ paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}
		>
			<Text style={{ color: normal() }}>
				{label}: {value ? 'on' : 'off'}
			</Text>
			{subLabel ? (
				<Text style={{ color: muted(), fontSize: 13, marginTop: 2 }}>
					{subLabel}
				</Text>
			) : null}
		</Pressable>
	)
}

/** A text field inside a real row, so it sits on the row's surface. */
export function Field({
	label,
	description,
	value,
	onChange,
	placeholder,
	multiline,
	maxLength,
}: {
	label: string
	description?: string
	value: string
	onChange: (value: string) => void
	placeholder?: string
	multiline?: boolean
	maxLength?: number
}) {
	// React Native's TextInput on purpose: Discord's design input swallows
	// onChangeText on some builds, so a field built on it cannot be typed into.
	const input = (
		<TextInput
			style={{
				color: normal(),
				backgroundColor: token('BACKGROUND_TERTIARY'),
				borderRadius: 8,
				padding: 10,
				minHeight: multiline ? 72 : undefined,
				textAlignVertical: multiline ? 'top' : 'center',
			}}
			value={value}
			onChangeText={onChange}
			placeholder={placeholder}
			placeholderTextColor={muted()}
			multiline={multiline}
			maxLength={maxLength}
		/>
	)
	const TableRow = component('TableRow')
	const DText = component('Text')
	if (TableRow) {
		return (
			<TableRow
				label={label}
				subLabel={
					<View style={{ gap: 8, marginTop: 8 }}>
						{input}
						{description && DText ? (
							<DText variant="text-xs/normal" color="text-muted">
								{description}
							</DText>
						) : description ? (
							<Text style={{ color: muted(), fontSize: 12 }}>{description}</Text>
						) : null}
					</View>
				}
			/>
		)
	}
	return (
		<View style={{ gap: 6, paddingVertical: 8 }}>
			<Text style={{ color: normal(), fontWeight: '600' }}>{label}</Text>
			{input}
			{description ? (
				<Text style={{ color: muted(), fontSize: 12 }}>{description}</Text>
			) : null}
		</View>
	)
}

/** A single-choice list, as Discord's radio rows or as plain rows. */
export function Choices<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T
	options: Array<{ value: T; label: string }>
	onChange: (value: T) => void
}) {
	const Group = component('TableRadioGroup')
	const RadioRow = component('TableRadioRow')
	if (Group && RadioRow) {
		return (
			<Group defaultValue={value} onChange={onChange}>
				{options.map(option => (
					<RadioRow key={option.value} value={option.value} label={option.label} />
				))}
			</Group>
		)
	}
	return (
		<View>
			{options.map(option => (
				<Pressable
					key={option.value}
					accessibilityLabel={option.label}
					onPress={() => onChange(option.value)}
					style={{ paddingVertical: 8 }}
				>
					<Text style={{ color: normal() }}>
						{option.value === value ? '● ' : '○ '}
						{option.label}
					</Text>
				</Pressable>
			))}
		</View>
	)
}

// ─── A card that says what is happening right now ────────────────────────────

export type Tone = 'normal' | 'brand' | 'muted' | 'danger'

const TONES: Record<Tone, string> = {
	normal: 'text-normal',
	brand: 'text-brand',
	muted: 'text-muted',
	danger: 'text-danger',
}

function toneColour(tone: Tone): string | undefined {
	if (tone === 'brand') return token('BRAND_500')
	if (tone === 'muted') return token('TEXT_MUTED')
	if (tone === 'danger') return token('TEXT_DANGER')
	return token('TEXT_NORMAL')
}

/**
 * The summary at the top of a page: a heading, a line in a tone, and at most one
 * action. It is the first thing a person reads, so it never hides behind a
 * switch.
 */
export function Hero({
	title,
	line,
	tone = 'muted',
	action,
}: {
	title: string
	line: string
	tone?: Tone
	action?: { label: string; onPress: () => void }
}) {
	const Card = component('Card')
	const Stack = component('Stack')
	const DText = component('Text')
	const Button = component('Button')
	if (Card && Stack && DText) {
		return (
			<Card>
				<Stack spacing={8}>
					<DText variant="heading-lg/bold">{title}</DText>
					<DText variant="text-md/medium" color={TONES[tone]}>
						{line}
					</DText>
					{action && Button ? (
						<Button text={action.label} variant="secondary" onPress={action.onPress} />
					) : action ? (
						<Pressable
							accessibilityLabel={action.label}
							onPress={action.onPress}
							style={{ paddingVertical: 8 }}
						>
							<Text style={{ color: token('BRAND_500') ?? normal() }}>
								{action.label}
							</Text>
						</Pressable>
					) : null}
				</Stack>
			</Card>
		)
	}
	return (
		<View
			style={{
				gap: 6,
				padding: 14,
				borderRadius: 10,
				backgroundColor: token('BACKGROUND_SECONDARY'),
			}}
		>
			<Text style={{ color: normal(), fontSize: 18, fontWeight: '700' }}>
				{title}
			</Text>
			<Text style={{ color: toneColour(tone), fontSize: 15 }}>{line}</Text>
			{action ? (
				<Pressable
					accessibilityLabel={action.label}
					onPress={action.onPress}
					style={{ paddingVertical: 6 }}
				>
					<Text style={{ color: token('BRAND_500') ?? normal() }}>
						{action.label}
					</Text>
				</Pressable>
			) : null}
		</View>
	)
}

/** A muted paragraph between groups. */
export function Note({ text }: { text: string }) {
	return (
		<Text style={{ color: muted(), fontSize: 13, lineHeight: 18 }}>{text}</Text>
	)
}
