import { app, BrowserWindow, ipcMain, dialog, session, Menu, Tray, nativeImage } from 'electron';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { AddGamePayload, GameSummary, Settings, StartupState } from '../shared/types';
import { loadSettings, saveSettings, updateSettings } from './services/settingsService';
import { getDb, closeDb } from './services/db';
import { listGames, addGame, getGameDetail, removeGame, getStoredGameById } from './services/gameService';
import { addSaveLocation, toggleSaveLocation, removeSaveLocation } from './services/saveLocationService';
import {
	backupGame,
	onBackupProgress,
	restoreSnapshot,
	verifySnapshot,
	deleteSnapshot,
	scanSnapshotsFromDisk,
	onSnapshotCreated,
} from './services/backupService';
import { startWatcher, refreshWatcher } from './services/watcherService';
import {
	startSessionMonitor,
	onSessionStatus,
	getRunningMap,
	registerLaunchedProcess,
} from './services/sessionService';
import { logEvent } from './services/eventLogService';
import { applyBootstrapUserDataPath, stageDataRootMigration } from './services/dataRootService';

let mainWindow: BrowserWindow | null = null;
let settings: Settings = {
	backupFrequencyMinutes: 5,
	retentionCount: 10,
	storageRoot: '',
	compressionEnabled: false,
	dataRoot: '',
};
let db: ReturnType<typeof getDb> | null = null;
let startupState: StartupState = {
	recoveryMode: false,
	reason: null,
	missingPath: null,
};
type WindowLayoutMode = 'normal' | 'widget';
let windowLayoutMode: WindowLayoutMode = 'normal';
let lastNormalBounds: { x: number; y: number; width: number; height: number } | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const RECOVERY_MODE_BLOCK_MESSAGE =
	'GameSaver is in recovery mode. Open Settings and set a valid Data Folder to continue.';

const NORMAL_WINDOW_DEFAULT_SIZE = {
	width: 884,
	height: 600,
};

const NORMAL_WINDOW_MIN_SIZE = {
	width: 600,
	height: 300,
};

const WIDGET_WINDOW_SIZE = {
	width: 400,
	height: 380,
};

const DEV_SERVER_ORIGIN = 'http://localhost:5175';

function buildContentSecurityPolicy(isDev: boolean): string {
	const baseDirectives = [
		"default-src 'self'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"object-src 'none'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"style-src 'self' 'unsafe-inline'",
	];
	if (isDev) {
		return [
			...baseDirectives,
			"script-src 'self' 'unsafe-inline'",
			`connect-src 'self' ${DEV_SERVER_ORIGIN} ws://localhost:5175`,
		].join('; ');
	}
	return [...baseDirectives, "script-src 'self'", "connect-src 'self'"].join('; ');
}

function isAllowedAppNavigation(urlValue: string, isDev: boolean): boolean {
	try {
		const url = new URL(urlValue);
		if (url.protocol === 'file:') {
			return true;
		}
		return isDev && url.origin === DEV_SERVER_ORIGIN;
	} catch {
		return false;
	}
}

function normalizeTrayIcon(image: NativeImage): NativeImage {
	return image.resize({ width: 16, height: 16 });
}

function getTrayIconPathCandidates(): string[] {
	const fileNames = ['icon.ico', 'icon.png'];
	const directories = [
		path.join(process.cwd(), 'build'),
		path.join(app.getAppPath(), 'build'),
		path.join(process.resourcesPath, 'build'),
		process.resourcesPath,
	];
	return directories.flatMap((directory) => fileNames.map((fileName) => path.join(directory, fileName)));
}

function resolveWindowIconPath(): string | undefined {
	const fileNames = ['icon.ico', 'icon.png'];
	const directories = [
		path.join(process.cwd(), 'build'),
		path.join(app.getAppPath(), 'build'),
		path.join(process.resourcesPath, 'build'),
		process.resourcesPath,
	];

	for (const directory of directories) {
		for (const fileName of fileNames) {
			const iconPath = path.join(directory, fileName);
			if (fs.existsSync(iconPath)) {
				return iconPath;
			}
		}
	}

	return undefined;
}

function resolveTrayIcon(): NativeImage {
	for (const iconPath of getTrayIconPathCandidates()) {
		if (!fs.existsSync(iconPath)) {
			continue;
		}
		const image = nativeImage.createFromPath(iconPath);
		if (!image.isEmpty()) {
			return normalizeTrayIcon(image);
		}
	}

	throw new Error(
		`Tray icon is required but no valid icon was found. Checked: ${getTrayIconPathCandidates().join(', ')}`,
	);
}

function showMainWindow(): void {
	if (!mainWindow) return;
	if (mainWindow.isMinimized()) {
		mainWindow.restore();
	}
	if (!mainWindow.isVisible()) {
		mainWindow.show();
	}
	mainWindow.focus();
}

function hideMainWindowToTray(): void {
	if (!tray) {
		quitApp();
		return;
	}
	mainWindow?.hide();
	updateTrayMenu();
}

function quitApp(): void {
	isQuitting = true;
	app.quit();
}

function updateTrayMenu(): void {
	if (!tray) return;
	const items: MenuItemConstructorOptions[] = [
		{
			label: mainWindow?.isVisible() ? 'Hide GameSaver' : 'Open GameSaver',
			click: () => {
				if (mainWindow?.isVisible()) {
					hideMainWindowToTray();
					return;
				}
				showMainWindow();
			},
		},
		{
			type: 'separator',
		},
		{
			label: 'Quit GameSaver',
			click: () => {
				quitApp();
			},
		},
	];
	tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray(): void {
	if (tray) return;
	try {
		tray = new Tray(resolveTrayIcon());
	} catch (error) {
		console.error(`[tray] Failed to initialize tray icon: ${getErrorMessage(error, 'Unknown tray error')}`);
		tray = null;
		return;
	}
	tray.setToolTip('GameSaver');
	tray.on('click', () => {
		if (mainWindow?.isVisible()) {
			hideMainWindowToTray();
			return;
		}
		showMainWindow();
	});
	tray.on('double-click', () => {
		showMainWindow();
	});
	updateTrayMenu();
}

function applyWindowLayout(mode: WindowLayoutMode): WindowLayoutMode {
	if (!mainWindow) return windowLayoutMode;

	if (mode === 'widget') {
		if (windowLayoutMode === 'normal') {
			lastNormalBounds = mainWindow.getBounds();
		}
		if (mainWindow.isMaximized()) {
			mainWindow.unmaximize();
		}
		mainWindow.setResizable(false);
		mainWindow.setMaximizable(false);
		mainWindow.setMinimumSize(WIDGET_WINDOW_SIZE.width, WIDGET_WINDOW_SIZE.height);
		mainWindow.setMaximumSize(WIDGET_WINDOW_SIZE.width, WIDGET_WINDOW_SIZE.height);
		mainWindow.setSize(WIDGET_WINDOW_SIZE.width, WIDGET_WINDOW_SIZE.height);
		windowLayoutMode = 'widget';
		return windowLayoutMode;
	}

	mainWindow.setMaximumSize(0, 0);
	mainWindow.setResizable(true);
	mainWindow.setMaximizable(true);
	mainWindow.setMinimumSize(NORMAL_WINDOW_MIN_SIZE.width, NORMAL_WINDOW_MIN_SIZE.height);
	if (lastNormalBounds) {
		mainWindow.setBounds(lastNormalBounds);
		lastNormalBounds = null;
	} else {
		mainWindow.setSize(NORMAL_WINDOW_DEFAULT_SIZE.width, NORMAL_WINDOW_DEFAULT_SIZE.height);
	}
	windowLayoutMode = mode;
	return windowLayoutMode;
}

if (!app.isPackaged) {
	app.disableHardwareAcceleration();
}

applyBootstrapUserDataPath();

const gameIconCache = new Map<string, string>();

function getIconCacheKey(exePath: string): string {
	return path.normalize(exePath).toLowerCase();
}

async function getGameExeIcon(exePath: string): Promise<string | null> {
	const cacheKey = getIconCacheKey(exePath);
	const cached = gameIconCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	if (!fs.existsSync(exePath)) {
		return null;
	}

	try {
		const icon = await app.getFileIcon(exePath, { size: 'normal' });
		if (icon.isEmpty()) {
			return null;
		}
		const dataUrl = icon.toDataURL();
		gameIconCache.set(cacheKey, dataUrl);
		return dataUrl;
	} catch {
		return null;
	}
}

async function attachGameIcons(games: GameSummary[]): Promise<GameSummary[]> {
	return await Promise.all(
		games.map(async (game) => ({
			...game,
			exe_icon: await getGameExeIcon(game.exe_path),
		})),
	);
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: NORMAL_WINDOW_DEFAULT_SIZE.width,
		height: NORMAL_WINDOW_DEFAULT_SIZE.height,
		icon: resolveWindowIconPath(),
		resizable: true,
		maximizable: true,
		autoHideMenuBar: true,
		backgroundColor: '#0f1115',
		frame: false,
		webPreferences: {
			preload: path.join(__dirname, '../preload/preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
		},
	});
	mainWindow.setMinimumSize(NORMAL_WINDOW_MIN_SIZE.width, NORMAL_WINDOW_MIN_SIZE.height);

	if (app.isPackaged) {
		mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
	} else {
		mainWindow.loadURL(DEV_SERVER_ORIGIN);
		mainWindow.webContents.openDevTools({ mode: 'detach' });
	}

	mainWindow.on('close', (event) => {
		if (isQuitting) {
			return;
		}
		if (!tray) {
			quitApp();
			return;
		}
		event.preventDefault();
		hideMainWindowToTray();
	});

	mainWindow.on('show', () => {
		updateTrayMenu();
	});

	mainWindow.on('hide', () => {
		updateTrayMenu();
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
		updateTrayMenu();
	});

	applyWindowLayout(windowLayoutMode);
}

function setupSecurity(): void {
	const isDev = !app.isPackaged;
	const csp = buildContentSecurityPolicy(isDev);

	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		if (details.resourceType !== 'mainFrame' || !isAllowedAppNavigation(details.url, isDev)) {
			callback({ responseHeaders: details.responseHeaders });
			return;
		}

		const responseHeaders: Record<string, string[] | undefined> = {
			...details.responseHeaders,
		};
		delete responseHeaders['content-security-policy'];
		delete responseHeaders['Content-Security-Policy'];

		callback({
			responseHeaders: {
				...responseHeaders,
				'Content-Security-Policy': [csp],
			},
		});
	});

	app.on('web-contents-created', (_event, contents) => {
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		contents.on('will-attach-webview', (event) => {
			event.preventDefault();
		});
		contents.on('will-navigate', (event, navigationUrl) => {
			if (!isAllowedAppNavigation(navigationUrl, isDev)) {
				event.preventDefault();
			}
		});
	});
}

function toRecord(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid payload for ${context}`);
	}
	return value as Record<string, unknown>;
}

function toNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new Error(`Invalid ${field}`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`Invalid ${field}`);
	}
	return trimmed;
}

function toBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

function toPositiveInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
		throw new Error(`Invalid ${field}`);
	}
	return Math.floor(value);
}

function parseAddGamePayload(input: unknown): AddGamePayload {
	const payload = toRecord(input, 'games:add');
	return {
		name: toNonEmptyString(payload.name, 'name'),
		exePath: toNonEmptyString(payload.exePath, 'exePath'),
		installPath: toNonEmptyString(payload.installPath, 'installPath'),
	};
}

function parseSaveLocationAddPayload(input: unknown): { gameId: string; path: string } {
	const payload = toRecord(input, 'savelocations:add');
	return {
		gameId: toNonEmptyString(payload.gameId, 'gameId'),
		path: toNonEmptyString(payload.path, 'path'),
	};
}

function parseTogglePayload(input: unknown): { id: string; enabled: boolean } {
	const payload = toRecord(input, 'savelocations:toggle');
	return {
		id: toNonEmptyString(payload.id, 'id'),
		enabled: toBoolean(payload.enabled, 'enabled'),
	};
}

function parseIdPayload(input: unknown, idField: string, context: string): string {
	const payload = toRecord(input, context);
	return toNonEmptyString(payload[idField], idField);
}

function parseSettingsUpdatePayload(input: unknown): Partial<Settings> {
	const payload = toRecord(input, 'settings:update');
	const next: Partial<Settings> = {};

	if (payload.backupFrequencyMinutes !== undefined) {
		next.backupFrequencyMinutes = toPositiveInteger(payload.backupFrequencyMinutes, 'backupFrequencyMinutes');
	}
	if (payload.retentionCount !== undefined) {
		next.retentionCount = toPositiveInteger(payload.retentionCount, 'retentionCount');
	}
	if (payload.storageRoot !== undefined) {
		next.storageRoot = toNonEmptyString(payload.storageRoot, 'storageRoot');
	}
	if (payload.dataRoot !== undefined) {
		next.dataRoot = toNonEmptyString(payload.dataRoot, 'dataRoot');
	}
	if (payload.compressionEnabled !== undefined) {
		next.compressionEnabled = toBoolean(payload.compressionEnabled, 'compressionEnabled');
	}

	return next;
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (typeof error === 'string' && error.trim().length > 0) {
		return error;
	}
	return fallback;
}

type SaveLocationDialogTarget = 'file' | 'folder';

async function showSaveLocationOpenDialog(target: SaveLocationDialogTarget): Promise<string | null> {
	const properties: Array<'openFile' | 'openDirectory'> = [target === 'file' ? 'openFile' : 'openDirectory'];
	const result = await dialog.showOpenDialog({
		properties,
	});
	return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function pickSaveLocationPath(): Promise<string | null> {
	const messageBoxOptions: Electron.MessageBoxOptions = {
		type: 'question',
		title: 'Add Save Location',
		message: 'Select what you want to back up.',
		detail: 'Choose File for a single save file, or Folder for a save directory.',
		buttons: ['File', 'Folder', 'Cancel'],
		defaultId: 0,
		cancelId: 2,
		noLink: true,
	};
	const choice = mainWindow
		? await dialog.showMessageBox(mainWindow, messageBoxOptions)
		: await dialog.showMessageBox(messageBoxOptions);

	if (choice.response === 2) {
		return null;
	}

	return await showSaveLocationOpenDialog(choice.response === 0 ? 'file' : 'folder');
}

function parseWindowsPathFromErrorMessage(message: string): string | null {
	const quotedMatch = message.match(/['"]([A-Za-z]:\\[^'"\r\n]+)['"]/);
	const rawPath = quotedMatch?.[1] ?? message.match(/[A-Za-z]:\\[^'"\r\n]*/)?.[0];
	if (!rawPath) {
		return null;
	}
	return rawPath.trim().replace(/[\\/]+$/, '');
}

function inferDataRootFromMissingPath(missingPath: string): string {
	const normalized = path.resolve(missingPath);
	const fileName = path.basename(normalized).toLowerCase();
	if (fileName === 'settings.json' || fileName === 'bootstrap.json') {
		return path.dirname(normalized);
	}
	if (fileName === 'backups') {
		return path.dirname(normalized);
	}
	return normalized;
}

function getFallbackDataRootPath(): string {
	return path.join(app.getPath('appData'), app.getName(), 'GameSaverData');
}

function toAppStatePath(dataRoot: string): string {
	return path.join(dataRoot, 'AppState');
}

function buildRecoverySettings(missingPath: string | null): Settings {
	const inferredRoot = missingPath ? inferDataRootFromMissingPath(missingPath) : null;
	const dataRoot = inferredRoot && inferredRoot.length > 0 ? inferredRoot : getFallbackDataRootPath();
	return {
		backupFrequencyMinutes: 5,
		retentionCount: 10,
		compressionEnabled: false,
		dataRoot,
		storageRoot: path.join(dataRoot, 'Backups'),
	};
}

function setStartupRecoveryState(error: unknown): void {
	const reason = getErrorMessage(error, 'Failed to initialize GameSaver data.');
	const missingPath = parseWindowsPathFromErrorMessage(reason);
	startupState = {
		recoveryMode: true,
		reason,
		missingPath,
	};
	settings = buildRecoverySettings(missingPath);
	db = null;
}

function clearStartupRecoveryState(): void {
	startupState = {
		recoveryMode: false,
		reason: null,
		missingPath: null,
	};
}

function getRequiredDb(): ReturnType<typeof getDb> {
	if (startupState.recoveryMode || !db) {
		throw new Error(RECOVERY_MODE_BLOCK_MESSAGE);
	}
	return db;
}

function startRuntimeServices(): void {
	const activeDb = getRequiredDb();
	startWatcher(activeDb, settings);
	startSessionMonitor(activeDb, settings);
}

async function recoverFromStartupFailure(payload: Partial<Settings>): Promise<Settings> {
	const previousUserData = app.getPath('userData');
	const requestedDataRoot = payload.dataRoot ? path.resolve(payload.dataRoot) : settings.dataRoot;
	const requestedStorageRoot = payload.storageRoot
		? path.resolve(payload.storageRoot)
		: path.join(requestedDataRoot, 'Backups');

	await fs.promises.mkdir(requestedDataRoot, { recursive: true });
	await fs.promises.mkdir(requestedStorageRoot, { recursive: true });

	const nextSettings: Settings = {
		...settings,
		...payload,
		dataRoot: requestedDataRoot,
		storageRoot: requestedStorageRoot,
	};

	try {
		app.setPath('userData', toAppStatePath(requestedDataRoot));
		await stageDataRootMigration({
			oldUserData: previousUserData,
			newUserData: requestedDataRoot,
			oldStorageRoot: settings.storageRoot,
			newStorageRoot: requestedStorageRoot,
			settingsToWrite: nextSettings,
		});
		await saveSettings(nextSettings);

		settings = nextSettings;
		closeDb();
		db = getDb(settings);
		clearStartupRecoveryState();
		startRuntimeServices();
		return settings;
	} catch (error) {
		app.setPath('userData', previousUserData);
		setStartupRecoveryState(error);
		throw error;
	}
}

function registerIpc(): void {
	ipcMain.handle('app:relaunch', () => {
		app.relaunch();
		app.exit(0);
	});
	ipcMain.handle('app:get-startup-state', () => startupState);

	ipcMain.handle('window:minimize', () => {
		mainWindow?.minimize();
	});

	ipcMain.handle('window:toggle-maximize', () => {
		if (!mainWindow) return false;
		if (mainWindow.isMaximized()) {
			mainWindow.unmaximize();
			return false;
		}
		mainWindow.maximize();
		return true;
	});

	ipcMain.handle('window:close', () => {
		if (tray) {
			hideMainWindowToTray();
			return;
		}
		mainWindow?.close();
	});

	ipcMain.handle('window:is-maximized', () => {
		return mainWindow?.isMaximized() ?? false;
	});

	ipcMain.handle('window:get-layout-mode', () => {
		return windowLayoutMode;
	});

	ipcMain.handle('window:set-layout-mode', (_event, modeValue: unknown) => {
		const mode = toNonEmptyString(modeValue, 'mode');
		if (mode !== 'normal' && mode !== 'widget') {
			throw new Error('Invalid mode');
		}
		return applyWindowLayout(mode);
	});

	ipcMain.handle('games:list', async () => {
		const activeDb = getRequiredDb();
		const games = listGames(activeDb, getRunningMap());
		return await attachGameIcons(games);
	});
	ipcMain.handle('games:get', (_event, gameIdValue: unknown) => {
		const activeDb = getRequiredDb();
		const gameId = toNonEmptyString(gameIdValue, 'gameId');
		return getGameDetail(activeDb, gameId);
	});
	ipcMain.handle('games:add', (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const payload = parseAddGamePayload(payloadValue);
		const game = addGame(activeDb, payload, settings.storageRoot);
		refreshWatcher(activeDb, settings);
		return game;
	});
	ipcMain.handle('games:remove', (_event, gameIdValue: unknown) => {
		const activeDb = getRequiredDb();
		const gameId = toNonEmptyString(gameIdValue, 'gameId');
		removeGame(activeDb, gameId, settings.storageRoot);
		refreshWatcher(activeDb, settings);
	});

	ipcMain.handle('games:launch', (_event, gameIdValue: unknown) => {
		const activeDb = getRequiredDb();
		const gameId = toNonEmptyString(gameIdValue, 'gameId');
		const game = getStoredGameById(activeDb, gameId);
		if (!game) {
			throw new Error('Game not found');
		}
		if (!fs.existsSync(game.exe_path)) {
			logEvent(activeDb, game.id, 'error', `Executable not found: ${game.exe_path}`);
			throw new Error('Executable not found');
		}

		const child = spawn(game.exe_path, [], {
			detached: true,
			stdio: 'ignore',
			cwd: path.dirname(game.exe_path),
		});
		if (child.pid) {
			registerLaunchedProcess(game.id, child.pid);
		}
		child.unref();
		logEvent(activeDb, game.id, 'backup', `Game launched.`);
	});

	ipcMain.handle('savelocations:add', (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const payload = parseSaveLocationAddPayload(payloadValue);
		const location = addSaveLocation(activeDb, payload.gameId, payload.path, false);
		refreshWatcher(activeDb, settings);
		backupGame(activeDb, settings, location.game_id, 'auto').catch((error) => {
			logEvent(
				activeDb,
				location.game_id,
				'error',
				`Auto backup after save-location add failed: ${getErrorMessage(error, 'Unknown error')}`,
			);
		});
		return location;
	});

	ipcMain.handle('savelocations:toggle', (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const payload = parseTogglePayload(payloadValue);
		const location = activeDb.state.saveLocations.find((item) => item.id === payload.id);
		const shouldTriggerBackup = Boolean(location && !location.enabled && payload.enabled);
		toggleSaveLocation(activeDb, payload.id, payload.enabled);
		refreshWatcher(activeDb, settings);
		if (shouldTriggerBackup && location) {
			backupGame(activeDb, settings, location.game_id, 'auto').catch((error) => {
				logEvent(
					activeDb,
					location.game_id,
					'error',
					`Auto backup after save-location enable failed: ${getErrorMessage(error, 'Unknown error')}`,
				);
			});
		}
	});

	ipcMain.handle('savelocations:remove', (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const payloadId = parseIdPayload(payloadValue, 'id', 'savelocations:remove');
		removeSaveLocation(activeDb, payloadId);
		refreshWatcher(activeDb, settings);
	});

	ipcMain.handle('backup:now', async (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const gameId = parseIdPayload(payloadValue, 'gameId', 'backup:now');
		await backupGame(activeDb, settings, gameId, 'manual');
	});

	ipcMain.handle('backup:scan', async () => {
		const activeDb = getRequiredDb();
		return await scanSnapshotsFromDisk(activeDb, settings);
	});

	ipcMain.handle('restore:snapshot', async (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const snapshotId = parseIdPayload(payloadValue, 'snapshotId', 'restore:snapshot');
		await restoreSnapshot(activeDb, settings, snapshotId);
	});

	ipcMain.handle('snapshot:verify', async (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const snapshotId = parseIdPayload(payloadValue, 'snapshotId', 'snapshot:verify');
		return verifySnapshot(activeDb, snapshotId);
	});

	ipcMain.handle('snapshot:remove', async (_event, payloadValue: unknown) => {
		const activeDb = getRequiredDb();
		const snapshotId = parseIdPayload(payloadValue, 'snapshotId', 'snapshot:remove');
		await deleteSnapshot(activeDb, snapshotId);
	});

	ipcMain.handle('settings:get', () => settings);
	ipcMain.handle('settings:update', async (_event, payloadValue: unknown) => {
		const validatedPayload = parseSettingsUpdatePayload(payloadValue);
		const normalizedPayload = {
			...validatedPayload,
			dataRoot: validatedPayload.dataRoot ? path.resolve(validatedPayload.dataRoot) : validatedPayload.dataRoot,
		};

		if (startupState.recoveryMode) {
			return await recoverFromStartupFailure(normalizedPayload);
		}

		const currentUserData = app.getPath('userData');
		const currentDataRoot = settings.dataRoot;
		const currentStorageRoot = settings.storageRoot;
		const next = await updateSettings(normalizedPayload);
		settings = next;
		const nextDataRoot = normalizedPayload.dataRoot;
		const dataRootChanged = typeof nextDataRoot === 'string' && nextDataRoot !== currentDataRoot;

		try {
			closeDb();
			if (dataRootChanged) {
				await stageDataRootMigration({
					oldUserData: currentUserData,
					newUserData: nextDataRoot,
					oldStorageRoot: currentStorageRoot,
					newStorageRoot: settings.storageRoot,
					settingsToWrite: settings,
				});
			}
			db = getDb(settings);
			startRuntimeServices();
			if (dataRootChanged) {
				mainWindow?.webContents.send('app:restart-required');
			}
		} catch (error) {
			setStartupRecoveryState(error);
			throw error;
		}

		return settings;
	});

	ipcMain.handle('dialog:pickExe', async () => {
		const result = await dialog.showOpenDialog({
			properties: ['openFile'],
			filters: [{ name: 'Executable', extensions: ['exe'] }],
		});
		return result.canceled ? null : result.filePaths[0];
	});

	ipcMain.handle('dialog:pickFolder', async () => {
		return await showSaveLocationOpenDialog('folder');
	});

	ipcMain.handle('dialog:pickSaveLocation', async () => {
		return await pickSaveLocationPath();
	});
}

app.whenReady().then(() => {
	app.setAppUserModelId('GameSaver');

	try {
		settings = loadSettings();
		db = getDb(settings);
		clearStartupRecoveryState();
	} catch (error) {
		setStartupRecoveryState(error);
	}

	setupSecurity();
	Menu.setApplicationMenu(null);
	registerIpc();
	createTray();
	createWindow();

	if (!startupState.recoveryMode && db) {
		startRuntimeServices();
	}

	onSessionStatus((payload) => {
		if (mainWindow) {
			mainWindow.webContents.send('games:status', payload);
		}
	});

	onSnapshotCreated((payload) => {
		if (mainWindow) {
			mainWindow.webContents.send('backup:created', payload);
		}
	});

	onBackupProgress((payload) => {
		if (mainWindow) {
			mainWindow.webContents.send('backup:progress', payload);
		}
	});

	if (mainWindow) {
		const sendWindowState = () => {
			mainWindow?.webContents.send('window:state', { isMaximized: mainWindow?.isMaximized() ?? false });
		};
		mainWindow.on('maximize', sendWindowState);
		mainWindow.on('unmaximize', sendWindowState);
	}
});

app.on('before-quit', () => {
	isQuitting = true;
});

app.on('will-quit', () => {
	tray?.destroy();
	tray = null;
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	if (mainWindow) {
		showMainWindow();
		return;
	}
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});
