// Theme tokens for plugin UI.
//
// Plugins render on top of three appearances (dark, midnight/AMOLED, light) and
// any theme the user selected, so a colour written into a style is wrong on at
// least two of them. `token` reads Discord's own semantic colour for the
// appearance that is active right now.
//
// The base comes from Discord's own theme when the tokens module exposes it.
// `Appearance.getColorScheme()` is the phone's light/dark setting, not the
// client's theme, so it is only a fallback: resolving against it puts
// dark-theme colours on a light page whenever the two disagree.
import { Tokens } from '@valenced/discord/common/tokens'
import { Appearance } from 'react-native'

// Only used when Discord's token module cannot be reached at all (a harness, or
// a build that renamed it). Without a colour React Native draws black text,
// which is invisible on Discord's dark theme; with it the page stays readable.
const READABLE_FALLBACK = '#dbdee1'

function recordOf(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: {}
}

// Discord's four bases: Ash is `dark`, Dark is `darker`, Light is `light`, and
// Onyx (the AMOLED theme) is `midnight`.
function baseFromTheme(value: unknown): string | null {
	let name = typeof value === 'string' ? value : ''
	if (!name) {
		const record = recordOf(value)
		if (typeof record.theme === 'string') name = record.theme
		else if (typeof record.name === 'string') name = record.name
	}
	switch (name.toLowerCase()) {
		case 'light':
			return 'light'
		case 'dark':
		case 'darker':
			return 'darker'
		case 'ash':
			return 'dark'
		case 'midnight':
		case 'onyx':
			return 'midnight'
		default:
			return null
	}
}

function activeBase(): string {
	try {
		const tokens = recordOf(Tokens)
		const root = recordOf(tokens.default)
		const internal = recordOf(root.internal)
		const getTheme = internal.getTheme
		const theme =
			typeof getTheme === 'function'
				? (getTheme as () => unknown)()
				: (root.theme ?? internal.currentTheme ?? internal.theme)
		const base = baseFromTheme(theme)
		if (base) return base
	} catch {
		// Fall through to the phone's appearance.
	}
	try {
		if (Appearance?.getColorScheme?.() === 'light') return 'light'
	} catch {
		// Fall through to the dark base.
	}
	return 'darker'
}

export function token(name: string): string | undefined {
	try {
		const module: any = Tokens
		if (!module) return undefined

		const definition = module?.SemanticColor?.[name]
		const resolve = module?.default?.internal?.resolveSemanticColor
		if (typeof resolve === 'function' && definition) {
			return resolve(activeBase(), definition)
		}

		// Older shape: the token module carries the colour objects directly.
		const colours = module?.default?.colors?.[name]
		if (typeof colours === 'string') return colours
		if (typeof definition === 'string') return definition
	} catch {
		// A missing or renamed token must not take a settings page down.
	}
	return undefined
}

// Body text: never returns nothing, because an unset colour means black text.
export function readableText(name = 'TEXT_NORMAL'): string {
	return token(name) ?? token('TEXT_NORMAL') ?? READABLE_FALLBACK
}

// A few names read better at the call site than at the token module.
export const textNormal = () => token('TEXT_NORMAL')
export const textMuted = () => token('TEXT_MUTED')
export const textDanger = () => token('TEXT_DANGER')
export const backgroundPrimary = () => token('BACKGROUND_PRIMARY')
export const backgroundSecondary = () => token('BACKGROUND_SECONDARY')
export const backgroundTertiary = () => token('BACKGROUND_TERTIARY')
export const brand = () => token('BRAND_500')
export const brandHover = () => token('BRAND_560')
export const border = () => token('BORDER_SUBTLE')
export const interactive = () => token('INTERACTIVE_NORMAL')

// The padding contract every settings page uses.
export const settingsScroll = {
	paddingHorizontal: 16,
	paddingTop: 16,
	gap: 16,
} as const
