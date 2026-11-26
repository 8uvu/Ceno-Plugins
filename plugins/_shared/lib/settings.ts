// Reading and writing a plugin's settings from a page.
//
// `use()` already gives the current value; the subscription is what makes a page
// notice a change that came from a listener (a reply sent, a message recorded)
// instead of only from the page itself.
import { useEffect, useState } from 'react'

export interface StorageLike<T> {
	use(): unknown
	set(patch: Partial<T>, flush?: boolean): Promise<unknown>
	subscribe?(listener: (value: T) => void): () => void
}

export type Setter<T> = (patch: Partial<T>) => void

export function useSettings<T extends object>(
	storage: StorageLike<T>,
	fallback: T,
): [T, Setter<T>] {
	// The counter is only there to redraw; the value is read fresh every render.
	const [, redraw] = useState(0)
	useEffect(() => {
		try {
			const off = storage.subscribe?.(() => redraw((n: number) => n + 1))
			return () => {
				try {
					off?.()
				} catch {}
			}
		} catch {
			return undefined
		}
	}, [storage])
	const settings = (storage.use() ?? fallback) as T
	const set: Setter<T> = patch => {
		try {
			Promise.resolve(storage.set(patch)).catch?.(() => {})
		} catch {}
	}
	return [settings, set]
}
