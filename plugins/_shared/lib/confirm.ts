// A confirmation that works on every build: the system alert is the one dialog
// React Native always has, so it is the one used here rather than Discord's own
// modal.
import { Alert } from 'react-native'

export function ask({
	title,
	body,
	confirm,
	cancel = 'Cancel',
	danger,
	onConfirm,
}: {
	title: string
	body: string
	confirm: string
	cancel?: string
	danger?: boolean
	onConfirm: () => void
}): boolean {
	try {
		Alert.alert(
			title,
			body,
			[
				{ text: cancel, style: 'cancel' },
				{ text: confirm, style: danger ? 'destructive' : 'default', onPress: onConfirm },
			],
			{ cancelable: true },
		)
		return true
	} catch {
		return false
	}
}
