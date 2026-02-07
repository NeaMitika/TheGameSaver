import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { Settings } from '../../shared/types';
import { ensureDir } from './storage';

const settingsFileName = 'settings.json';
const appStateFolderName = 'AppState';

const defaultSettings: Settings = {
  backupFrequencyMinutes: 5,
  retentionCount: 10,
  storageRoot: '',
  compressionEnabled: false,
  dataRoot: ''
};

let cachedSettings: Settings | null = null;

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), settingsFileName);
}

function getDataRootFromUserDataPath(userDataPath: string): string {
  const normalized = path.normalize(userDataPath);
  if (path.basename(normalized).toLowerCase() === appStateFolderName.toLowerCase()) {
    return path.dirname(normalized);
  }
  return normalized;
}

function getDefaultStorageRootForDataRoot(dataRoot: string): string {
  return path.join(dataRoot, 'Backups');
}

export function loadSettings(): Settings {
  if (cachedSettings) {
    return cachedSettings;
  }

  const settingsPath = getSettingsPath();
  const dataRoot = getDataRootFromUserDataPath(app.getPath('userData'));
  const defaults: Settings = {
    ...defaultSettings,
    storageRoot: getDefaultStorageRootForDataRoot(dataRoot),
    dataRoot
  };

  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      cachedSettings = {
        ...defaults,
        ...parsed,
        storageRoot: parsed.storageRoot || defaults.storageRoot,
        dataRoot: parsed.dataRoot || defaults.dataRoot
      };
    } else {
      cachedSettings = defaults;
      ensureDir(app.getPath('userData'));
      fs.writeFileSync(settingsPath, JSON.stringify(cachedSettings, null, 2), 'utf-8');
    }
  } catch {
    cachedSettings = defaults;
  }

  ensureDir(cachedSettings.dataRoot);
  ensureDir(cachedSettings.storageRoot);
  return cachedSettings;
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  cachedSettings = settings;
  await fs.promises.mkdir(settings.dataRoot, { recursive: true });
  await fs.promises.mkdir(settings.storageRoot, { recursive: true });
  await fs.promises.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  return settings;
}

export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = loadSettings();
  const nextDataRoot = partial.dataRoot ? path.resolve(partial.dataRoot) : current.dataRoot;
  const nextStorageRoot = partial.storageRoot
    ? path.resolve(partial.storageRoot)
    : partial.dataRoot
      ? getDefaultStorageRootForDataRoot(nextDataRoot)
      : current.storageRoot;

  const next: Settings = {
    ...current,
    ...partial,
    dataRoot: nextDataRoot,
    storageRoot: nextStorageRoot
  };

  if (next.storageRoot !== current.storageRoot) {
    await moveDirectory(current.storageRoot, next.storageRoot);
  }

  return await saveSettings(next);
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  if (!fs.existsSync(source)) {
    await fs.promises.mkdir(destination, { recursive: true });
    return;
  }

  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.rename(source, destination);
    return;
  } catch {
    // fall back to copy across devices
  }

  await fs.promises.mkdir(destination, { recursive: true });
  try {
    await fs.promises.cp(source, destination, { recursive: true });
    await fs.promises.rm(source, { recursive: true, force: true });
  } catch (error: unknown) {
    const details = error instanceof Error && error.message ? ` ${error.message}` : '';
    throw new Error(`Failed to migrate storage root to "${destination}".${details}`);
  }
}
