// Small reads from the client that more than one plugin needs: a store by name,
// a person's name, a channel's name, and the two ways text is shortened.
//
// Every lookup is guarded, because a build is allowed to be missing a store or
// to have renamed one, and a missing name should fall back to the id rather than
// take a settings page or a menu down.
import { Stores } from '@valenced/discord/flux'

export function storeNamed(name: string): Record<string, unknown> | null {
	try {
		const found = (Stores as unknown as Record<string, unknown>)[name]
		return found && typeof found === 'object'
			? (found as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}

export function userName(id: string): string {
	const lookup = storeNamed('UserStore')?.getUser
	if (typeof lookup !== 'function') return id
	try {
		const user = (lookup as (id: string) => unknown)(id)
		const record =
			user && typeof user === 'object' ? (user as Record<string, unknown>) : {}
		const name = record.globalName ?? record.username
		return typeof name === 'string' && name ? name : id
	} catch {
		return id
	}
}

export function channelName(id: string): string {
	const lookup = storeNamed('ChannelStore')?.getChannel
	if (typeof lookup !== 'function') return id
	try {
		const channel = (lookup as (id: string) => unknown)(id)
		const record =
			channel && typeof channel === 'object'
				? (channel as Record<string, unknown>)
				: {}
		if (typeof record.name === 'string' && record.name) return '#' + record.name
		const recipients = Array.isArray(record.recipients) ? record.recipients : []
		const other = recipients[0]
		if (other && typeof other === 'object') {
			const person = other as Record<string, unknown>
			const name = person.globalName ?? person.username
			if (typeof name === 'string' && name) return name
		}
	} catch {}
	return id
}

export function selfId(): string {
	try {
		const current = storeNamed('UserStore')?.getCurrentUser
		if (typeof current !== 'function') return ''
		const user = (current as () => unknown)()
		const record =
			user && typeof user === 'object' ? (user as Record<string, unknown>) : {}
		return typeof record.id === 'string' ? record.id : ''
	} catch {
		return ''
	}
}

// One line, no runs of whitespace, clipped so a long message cannot fill a toast
// or a settings row.
export function clip(text: string, limit = 140): string {
	const clean = text.replace(/\s+/g, ' ').trim()
	if (!clean) return ''
	return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean
}

// A duration, the shortest way that still reads: 40s, 12m, 3h, 5d.
export function span(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return seconds + 's'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return minutes + 'm'
	const hours = Math.round(minutes / 60)
	if (hours < 24) return hours + 'h'
	return Math.round(hours / 24) + 'd'
}

export function ago(at: number, now: number): string {
	return span(now - at) + ' ago'
}
