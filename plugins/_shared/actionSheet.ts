// Discord's message long-press sheet, patched by appending rows to the sheet the
// component returns. This is the shape the community plugins use and the one
// that survives a build moving things around: the component is found by name,
// its render function is wrapped, and every step is wrapped so a menu that
// changed shape loses the extra rows instead of breaking the menu.
import { Design } from '@valenced/discord/design'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { asRecord } from './types'
import type { Logger } from './types'

interface ElementLike {
	type?: unknown
	props?: Record<string, unknown>
}

function asElement(value: unknown): ElementLike | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const element = value as ElementLike
	return element.props && typeof element.props === 'object' ? element : null
}

function typeName(type: unknown): string {
	if (typeof type !== 'function') return ''
	const named = type as { displayName?: string; name?: string }
	return named.displayName ?? named.name ?? ''
}

// The sheet sits inside the component's output, not at its root, so the element
// tree is walked until Discord's own ActionSheet is reached.
function findSheet(
	value: unknown,
	seen = new Set<unknown>(),
	depth = 0,
): ElementLike | null {
	if (!value || typeof value !== 'object' || depth > 32) return null
	if (seen.has(value)) return null
	seen.add(value)
	if (Array.isArray(value)) {
		for (const child of value) {
			const found = findSheet(child, seen, depth + 1)
			if (found) return found
		}
		return null
	}
	const element = asElement(value)
	if (!element) return null
	const marker = asRecord(Design).ActionSheet
	if (
		(typeof marker === 'function' && element.type === marker) ||
		typeName(element.type) === 'ActionSheet'
	) {
		return element
	}
	return findSheet(element.props?.children, seen, depth + 1)
}

function appendRows(tree: unknown, rows: unknown[]): boolean {
	const sheet = findSheet(tree)
	if (!sheet?.props) return false
	sheet.props.children = [sheet.props.children].flat().filter(Boolean).concat(rows)
	return true
}

/**
 * Adds rows to the message long-press sheet. `rowsFor` receives the sheet's own
 * props and returns the rows to append; an empty array leaves the menu alone.
 * Returns the unpatcher, ready for `cleanup`.
 */
export function addMessageMenuRows(
	rowsFor: (props: Record<string, unknown>) => unknown[],
	logger?: Logger,
): () => void {
	if (typeof asRecord(Design).ActionSheetRow !== 'function') return () => {}
	let unpatch: (() => void) | undefined
	const unsubscribe = getModules(
		withName('LongPressMessageActionSheet'),
		exports => {
			const module = exports as { default?: unknown }
			if (typeof module.default !== 'function') return
			unpatch = instead(module, 'default', (args, original) => {
				const tree = Reflect.apply(original, undefined, args) as unknown
				try {
					const rows = rowsFor(asRecord(args[0]))
					if (rows.length) appendRows(tree, rows)
				} catch (error) {
					logger?.warn?.('[menu] could not add rows', error)
				}
				return tree
			})
		},
		{ returnNamespace: true },
	)
	return () => {
		unsubscribe()
		unpatch?.()
		unpatch = undefined
	}
}
