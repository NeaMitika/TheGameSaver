import { useEffect, useState } from 'react';
import type { GameDetail, GameSummary } from '@shared/types';
import AddGamePanel from './components/AddGamePanel';
import GameDetailPanel from './components/GameDetailPanel';
import SettingsPanel from './components/SettingsPanel';
import AppHeader from './components/dashboard/AppHeader';
import DashboardScreen from './components/dashboard/DashboardScreen';
import { Button } from './components/ui/button';
import { useBackupProgressToasts } from './hooks/useBackupProgressToasts';
import { useCatalogDetectionToasts } from './hooks/useCatalogDetectionToasts';
import { useDashboardActions } from './hooks/useDashboardActions';
import { useDashboardOverview } from './hooks/useDashboardOverview';
import { useToastNotifications } from './hooks/useToastNotifications';
import { EMPTY_SETTINGS, EMPTY_STARTUP_STATE } from './types/app';
import type { LayoutMode, Screen } from './types/app';

export default function App() {
	const [screen, setScreen] = useState<Screen>('dashboard');
	const [games, setGames] = useState<GameSummary[]>([]);
	const [selectedDetail, setSelectedDetail] = useState<GameDetail | null>(null);
	const [settings, setSettings] = useState(EMPTY_SETTINGS);
	const [restartRequired, setRestartRequired] = useState(false);
	const [layoutMode, setLayoutMode] = useState<LayoutMode>('normal');
	const [isScanningBackups, setIsScanningBackups] = useState(false);
	const [startupState, setStartupState] = useState(EMPTY_STARTUP_STATE);
	const isRecoveryMode = startupState.recoveryMode;

	const { showNotice, showError } = useToastNotifications();
	useBackupProgressToasts();
	useCatalogDetectionToasts();
	const { runningMap, overview } = useDashboardOverview(games);
	const {
		refreshGames,
		openDetail,
		refreshDetail,
		handleCreated,
		handleRemove,
		handleBackupNow,
		handleScanBackups,
		toggleLayoutMode,
	} = useDashboardActions({
		isRecoveryMode,
		isScanningBackups,
		selectedDetail,
		layoutMode,
		setScreen,
		setGames,
		setSelectedDetail,
		setLayoutMode,
		setIsScanningBackups,
		showError,
	});

	useEffect(() => {
		let disposed = false;

		const initialize = async () => {
			let startup = EMPTY_STARTUP_STATE;
			try {
				startup = await window.gamesaver.getStartupState();
			} catch {
				// Ignore startup-state read errors and continue as normal mode.
			}
			if (disposed) return;
			setStartupState(startup);
			window.gamesaver
				.getSettings()
				.then((nextSettings) => {
					if (!disposed) {
						setSettings(nextSettings);
					}
				})
				.catch(() => undefined);

			if (startup.recoveryMode) {
				setScreen('settings');
				return;
			}

			await refreshGames();
		};
		void initialize();

		const unsubscribeStatus = window.gamesaver.onGameStatus((payload) => {
			setGames((prev) =>
				prev.map((game) => (game.id === payload.gameId ? { ...game, is_running: payload.isRunning } : game)),
			);
		});
		const unsubscribeBackupCreated = window.gamesaver.onBackupCreated((payload) => {
			void refreshGames();
			void window.gamesaver
				.getGame(payload.gameId)
				.then((detail) => {
					setSelectedDetail((prev) => (prev && prev.game.id === payload.gameId ? detail : prev));
				})
				.catch(() => undefined);
		});
		const unsubscribeCatalogProgress = window.gamesaver.onCatalogDetectionProgress((payload) => {
			if (payload.stage !== 'completed' && payload.stage !== 'failed') {
				return;
			}
			void refreshGames();
			void window.gamesaver
				.getGame(payload.gameId)
				.then((detail) => {
					setSelectedDetail((prev) => (prev && prev.game.id === payload.gameId ? detail : prev));
				})
				.catch(() => undefined);
		});

		window.gamesaver.windowControls
			.getLayoutMode()
			.then(setLayoutMode)
			.catch(() => undefined);

		const unsubscribeRestart = window.gamesaver.onRestartRequired(() => {
			setRestartRequired(true);
		});

		return () => {
			disposed = true;
			unsubscribeStatus();
			unsubscribeBackupCreated();
			unsubscribeCatalogProgress();
			unsubscribeRestart();
		};
	}, []);

	return (
		<div className='min-h-full bg-background text-foreground'>
			<AppHeader
				isRecoveryMode={isRecoveryMode}
				layoutMode={layoutMode}
				isScanningBackups={isScanningBackups}
				onAddGame={() => setScreen('add')}
				onOpenSettings={() => setScreen('settings')}
				onScanBackups={() => void handleScanBackups()}
				onToggleLayoutMode={() => void toggleLayoutMode()}
				onCloseToTray={() => void window.gamesaver.windowControls.close()}
				onToggleMaximize={() => void window.gamesaver.windowControls.toggleMaximize()}
			/>

			<main className='mx-auto flex w-full flex-col gap-4 p-4'>
				{isRecoveryMode && (
					<div className='flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm'>
						<span>
							Recovery mode:{' '}
							{startupState.missingPath
								? `Could not access ${startupState.missingPath}.`
								: 'Saved data path is unavailable.'}
						</span>
						<Button variant='outline' size='sm' onClick={() => setScreen('settings')}>
							Open Settings
						</Button>
					</div>
				)}

				{restartRequired && (
					<div className='flex flex-wrap items-center justify-between gap-3 rounded-md border bg-secondary px-3 py-2 text-sm text-secondary-foreground'>
						<span>Data folder updated. Restart required to fully switch app data.</span>
						<Button variant='outline' size='sm' onClick={() => void window.gamesaver.relaunchApp()}>
							Restart Now
						</Button>
					</div>
				)}

				{screen === 'dashboard' && (
					<DashboardScreen
						isRecoveryMode={isRecoveryMode}
						layoutMode={layoutMode}
						games={games}
						overview={overview}
						onAddGame={() => setScreen('add')}
						onOpenSettings={() => setScreen('settings')}
						onOpenDetail={(gameId) => void openDetail(gameId)}
						onBackupNow={(gameId) => void handleBackupNow(gameId)}
					/>
				)}

				{screen === 'add' && (
					<AddGamePanel
						onCancel={() => setScreen('dashboard')}
						onCreated={handleCreated}
						onError={(message) => showNotice('error', message, 5000)}
					/>
				)}

				{screen === 'settings' && (
					<SettingsPanel
						settings={settings}
						onCancel={() => setScreen('dashboard')}
						onError={(message) => showNotice('error', message, 5000)}
						onSaved={async (next) => {
							setSettings(next);
							const nextStartupState = await window.gamesaver.getStartupState().catch(() => EMPTY_STARTUP_STATE);
							setStartupState(nextStartupState);
							if (!nextStartupState.recoveryMode) {
								await refreshGames();
								showNotice('success', 'Settings saved.');
							} else {
								showNotice('error', 'Recovery mode is still active. Choose a reachable data folder.', 5000);
							}
							setScreen('dashboard');
						}}
					/>
				)}

				{screen === 'detail' && selectedDetail && (
					<GameDetailPanel
						detail={selectedDetail}
						isRunning={runningMap.get(selectedDetail.game.id) ?? false}
						onBack={() => {
							setScreen('dashboard');
							setSelectedDetail(null);
						}}
						onRefresh={refreshDetail}
						onRemove={handleRemove}
						onError={(message) => showNotice('error', message, 5000)}
						onSuccess={(message) => showNotice('success', message)}
					/>
				)}
			</main>
		</div>
	);
}
