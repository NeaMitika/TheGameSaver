import { useEffect } from 'react';
import { toast } from '@renderer/components/ui/sonner';

const CATALOG_PROGRESS_TOAST_PREFIX = 'catalog-detection:';
const CATALOG_RESULT_TOAST_DURATION_MS = 5000;

function getCatalogProgressToastId(gameId: string): string {
	return `${CATALOG_PROGRESS_TOAST_PREFIX}${gameId}`;
}

export function useCatalogDetectionToasts(): void {
	useEffect(() => {
		const unsubscribe = window.gamesaver.onCatalogDetectionProgress((payload) => {
			const toastId = getCatalogProgressToastId(payload.gameId);

			if (payload.stage === 'started' || payload.stage === 'progress') {
				toast.loading(`Detecting save path for ${payload.gameName}`, {
					id: toastId,
					duration: Infinity,
					closeButton: false,
					dismissible: false,
				});
				return;
			}

			toast.dismiss(toastId);

			if (payload.stage === 'failed') {
				toast.error(payload.message || 'Automatic save-path detection failed.', {
					duration: CATALOG_RESULT_TOAST_DURATION_MS,
				});
				return;
			}

			if (payload.resolvedPath) {
				toast.success('Save path auto-detected.', {
					duration: CATALOG_RESULT_TOAST_DURATION_MS,
				});
				return;
			}

			toast.warning(payload.message || 'Save-path detection completed with warnings.', {
				duration: CATALOG_RESULT_TOAST_DURATION_MS,
			});
		});

		return () => {
			unsubscribe();
		};
	}, []);
}
