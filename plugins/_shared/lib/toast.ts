// One toast helper, so every plugin says things the same way and a build
// without the toast action still tells the person what happened.
import { ToastActionCreators } from '@valenced/discord/actions'

export type ToastTone = 'default' | 'success' | 'critical'

export function say(
	key: string,
	text: string,
	tone: ToastTone = 'default',
): void {
	try {
		ToastActionCreators.open(key, {
			text,
			variant: tone === 'default' ? undefined : tone,
		})
		return
	} catch {}
	try {
		ToastActionCreators.open({ key, content: text })
	} catch {}
}
