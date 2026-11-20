// Theme tokens for plugin UI.
//
// Plugins render on top of three appearances (dark, midnight/AMOLED, light) and
// any theme the user selected, so a colour written into a style is wrong on at
// least two of them. `token` reads Discord's own semantic colour for the
// appearance that is active right now.
//
// Nothing here hardcodes a colour: the value comes from Discord's token module.
// When that module is not reachable (a unit-test harness, or a build that
// renamed it) the lookup returns undefined and the platform's default colour
// applies, which is always legible.
import { Tokens } from '@valenced/discord/common/tokens'
import { Appearance } from 'react-native'

type Appearance2 = 'dark' | 'light'

// Discord's bases: `darker` is the "Dark" option, `midnight` the AMOLED one.
function activeBase(): string {
	try {
		if (Appearance?.getColorScheme?.() === 'light') return 'light'
	} catch {
		// Fall through to the dark base.
	}
	return 'dark'
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
