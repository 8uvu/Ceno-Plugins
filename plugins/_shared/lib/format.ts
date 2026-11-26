// Text helpers the pages and toasts share.
export { ago, clip, channelName, selfId, span, storeNamed, userName } from '../lookup'

export function plural(count: number, one: string, many = one + 's'): string {
	return count === 1 ? one : many
}

/** A comma- or newline-separated list, trimmed, lowercased and deduplicated. */
export function listOf(
	raw: string,
	limit = 50,
	maxLength = 40,
): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const part of raw.split(/[\n,]+/)) {
		const word = part.trim().toLowerCase()
		if (!word || word.length > maxLength || seen.has(word)) continue
		seen.add(word)
		out.push(word)
		if (out.length >= limit) break
	}
	return out
}

/** "Ada", "Ada and Bob", "Ada, Bob and Cara". */
export function phrase(names: string[]): string {
	const list = names.filter(Boolean)
	if (list.length === 0) return ''
	if (list.length === 1) return list[0] as string
	if (list.length === 2) return `${list[0]} and ${list[1]}`
	return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1]
}
