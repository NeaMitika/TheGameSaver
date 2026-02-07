import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import {
  BackupScanResult,
  Game,
  SaveLocation,
  Settings,
  Snapshot,
  SnapshotFile,
  VerifyResult
} from '../../shared/types';
import { copyFileWithRetries, removeDirSafe, walkFiles } from './fileOps';
import { AppDb, StoredGame, StoredSaveLocation, persistDb } from './db';
import { logEvent } from './eventLogService';
import { updateGameStatus, getStoredGameById } from './gameService';
import { hashFile, hashText } from './hash';
import { listSaveLocations } from './saveLocationService';
import { ensureDir, getSnapshotRoot, toSafeGameFolderName } from './storage';

const inFlight = new Set<string>();
const SNAPSHOT_MANIFEST_FILE_NAME = 'snapshot.manifest.json';

interface SnapshotManifestLocation {
  path: string;
  type: SaveLocation['type'];
  auto_detected: boolean;
  enabled: boolean;
  storage_folder: string;
}

interface SnapshotManifestPayload {
  version: 2;
  snapshot_id: string;
  created_at: string;
  reason: Snapshot['reason'];
  locations: Record<string, SnapshotManifestLocation>;
}

interface ScannedSnapshotPayload {
  snapshot: Snapshot;
  files: SnapshotFile[];
  locationSeeds: StoredSaveLocation[];
}

interface RecoveredGameMetadata {
  game: StoredGame;
  gameFolder: string;
}

export async function scanSnapshotsFromDisk(db: AppDb, settings: Settings): Promise<BackupScanResult> {
  ensureDir(settings.storageRoot);

  const existingSnapshotIds = new Set(db.state.snapshots.map((row) => row.id));
  const existingSnapshotStoragePaths = new Set(
    db.state.snapshots.map((row) => normalizePathForKey(row.storage_path))
  );
  const gamesByFolder = new Map(
    db.state.games.map((game) => [game.folder_name.toLowerCase(), game] as const)
  );
  const gamesById = new Map(db.state.games.map((game) => [game.id, game] as const));

  const discoveredGames = new Map<string, StoredGame>();
  const discoveredLocationSeeds = new Map<string, StoredSaveLocation>();
  const discoveredSnapshots: ScannedSnapshotPayload[] = [];
  let updatedExistingGameFolders = 0;

  const result: BackupScanResult = {
    addedSnapshots: 0,
    removedSnapshots: 0,
    removedSnapshotFiles: 0,
    skippedUnknownGames: 0,
    skippedInvalidSnapshots: 0
  };

  const gameEntries = await readDirectoryEntries(settings.storageRoot);
  for (const gameEntry of gameEntries) {
    if (!gameEntry.isDirectory()) {
      continue;
    }

    const gameFolder = gameEntry.name;
    const snapshotsRoot = path.join(settings.storageRoot, gameFolder, 'Snapshots');
    if (!isDirectoryPath(snapshotsRoot)) {
      continue;
    }

    let game = gamesByFolder.get(gameFolder.toLowerCase());
    if (!game) {
      const recovered = readGameMetadata(settings.storageRoot, gameFolder);
      if (recovered) {
        const existingById = gamesById.get(recovered.game.id);
        if (existingById) {
          if (existingById.folder_name !== recovered.gameFolder) {
            existingById.folder_name = recovered.gameFolder;
            updatedExistingGameFolders += 1;
          }
          game = existingById;
        } else {
          discoveredGames.set(recovered.game.id, recovered.game);
          game = recovered.game;
          gamesById.set(game.id, game);
        }
        gamesByFolder.set(gameFolder.toLowerCase(), game);
      }
    }

    const snapshotEntries = await readDirectoryEntries(snapshotsRoot);
    for (const snapshotEntry of snapshotEntries) {
      if (!snapshotEntry.isDirectory()) {
        continue;
      }

      if (!game) {
        result.skippedUnknownGames += 1;
        continue;
      }

      const snapshotPath = path.join(snapshotsRoot, snapshotEntry.name);
      const snapshotPathKey = normalizePathForKey(snapshotPath);
      if (existingSnapshotStoragePaths.has(snapshotPathKey)) {
        continue;
      }

      const scanned = await scanSingleSnapshot(game.id, snapshotPath, existingSnapshotIds);
      if (!scanned) {
        result.skippedInvalidSnapshots += 1;
        continue;
      }

      discoveredSnapshots.push(scanned);
      existingSnapshotIds.add(scanned.snapshot.id);
      existingSnapshotStoragePaths.add(snapshotPathKey);
      for (const seed of scanned.locationSeeds) {
        const key = `${seed.game_id}:${seed.id}`;
        const previous = discoveredLocationSeeds.get(key);
        if (!previous) {
          discoveredLocationSeeds.set(key, seed);
        }
      }
    }
  }

  const staleSnapshotIds = db.state.snapshots
    .filter((snapshot) => !isDirectoryPath(snapshot.storage_path))
    .map((snapshot) => snapshot.id);

  for (const snapshotId of staleSnapshotIds) {
    const removedFiles = db.state.snapshotFiles.filter((file) => file.snapshot_id === snapshotId).length;
    result.removedSnapshotFiles += removedFiles;
    db.state.snapshotFiles = db.state.snapshotFiles.filter((file) => file.snapshot_id !== snapshotId);
    db.state.snapshots = db.state.snapshots.filter((snapshot) => snapshot.id !== snapshotId);
    result.removedSnapshots += 1;
  }

  for (const game of discoveredGames.values()) {
    const exists = db.state.games.some((row) => row.id === game.id);
    if (!exists) {
      db.state.games.push(game);
      gamesById.set(game.id, game);
    }
  }

  for (const location of discoveredLocationSeeds.values()) {
    const exists = db.state.saveLocations.some((row) => row.id === location.id);
    if (!exists) {
      db.state.saveLocations.push(location);
    }
  }

  for (const discovered of discoveredSnapshots) {
    db.state.snapshots.push(discovered.snapshot);
    db.state.snapshotFiles.push(...discovered.files);
    result.addedSnapshots += 1;
  }

  if (
    staleSnapshotIds.length > 0 ||
    updatedExistingGameFolders > 0 ||
    discoveredGames.size > 0 ||
    discoveredLocationSeeds.size > 0 ||
    discoveredSnapshots.length > 0
  ) {
    persistDb(db);
  }

  return result;
}

export async function backupGame(
  db: AppDb,
  settings: Settings,
  gameId: string,
  reason: Snapshot['reason'],
  options: { skipRetention?: boolean } = {}
): Promise<Snapshot | null> {
  if (inFlight.has(gameId)) return null;
  inFlight.add(gameId);

  const game = getStoredGameById(db, gameId);
  if (!game) {
    inFlight.delete(gameId);
    throw new Error('Game not found');
  }

  const snapshotId = uuid();
  const createdAt = new Date().toISOString();
  const snapshotFolder = resolveUniqueSnapshotFolderName(settings.storageRoot, game.folder_name, createdAt);
  const snapshotRoot = getSnapshotRoot(settings.storageRoot, game.folder_name, snapshotFolder);

  try {
    ensureDir(snapshotRoot);
    const locations = listSaveLocations(db, gameId).filter((loc) => loc.enabled);
    const locationStorageFolders = buildLocationStorageFolders(locations);

    if (locations.length === 0) {
      updateGameStatus(db, gameId, 'warning');
      logEvent(db, gameId, 'error', 'Backup skipped: no enabled save locations.');
      return null;
    }

    const snapshotFiles: SnapshotFile[] = [];
    let totalSize = 0;
    let warnings = 0;

    for (const location of locations) {
      if (!fs.existsSync(location.path)) {
        warnings += 1;
        logEvent(db, gameId, 'error', `Save location missing: ${location.path}`);
        continue;
      }

      const files = await listFilesForLocation(location);
      for (const filePath of files) {
        const relativePath =
          location.type === 'file' ? path.basename(filePath) : path.relative(location.path, filePath);
        const locationFolder = locationStorageFolders.get(location.id) ?? location.id;
        const destPath = path.join(snapshotRoot, locationFolder, relativePath);
        await copyFileWithRetries(filePath, destPath, 4);

        const stats = await fs.promises.stat(destPath);
        const checksum = await hashFile(destPath);
        snapshotFiles.push({
          id: uuid(),
          snapshot_id: snapshotId,
          location_id: location.id,
          relative_path: relativePath,
          size_bytes: stats.size,
          checksum
        });
        totalSize += stats.size;
      }
    }

    if (snapshotFiles.length === 0) {
      updateGameStatus(db, gameId, 'warning');
      logEvent(db, gameId, 'error', 'Backup skipped: no files found in enabled save locations.');
      await removeDirSafe(snapshotRoot);
      return null;
    }

    const snapshot: Snapshot = {
      id: snapshotId,
      game_id: gameId,
      created_at: createdAt,
      size_bytes: totalSize,
      checksum: computeSnapshotChecksum(snapshotFiles),
      storage_path: snapshotRoot,
      reason
    };

    await writeSnapshotManifest(snapshotRoot, snapshot, locations, locationStorageFolders);
    db.state.snapshots.push(snapshot);
    db.state.snapshotFiles.push(...snapshotFiles);
    persistDb(db);

    if (!options.skipRetention) {
      await applyRetentionPolicy(db, settings, gameId);
    }

    updateGameStatus(db, gameId, warnings > 0 ? 'warning' : 'protected');
    logEvent(db, gameId, 'backup', `Snapshot created (${reason}).`);
    return snapshot;
  } catch (error: any) {
    updateGameStatus(db, gameId, 'warning');
    logEvent(db, gameId, 'error', `Backup failed: ${error.message || error}`);
    await removeDirSafe(snapshotRoot);
    throw error;
  } finally {
    inFlight.delete(gameId);
  }
}

export async function restoreSnapshot(db: AppDb, settings: Settings, snapshotId: string): Promise<void> {
  const snapshot = db.state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    throw new Error('Snapshot not found');
  }

  const gameId = snapshot.game_id;
  const saveLocations = listSaveLocations(db, gameId);
  const locationMap = new Map(saveLocations.map((loc) => [loc.id, loc]));
  const files = db.state.snapshotFiles.filter((item) => item.snapshot_id === snapshotId);
  const manifest = await readSnapshotManifest(snapshot.storage_path);
  if (!manifest) {
    throw new Error('Snapshot manifest is missing or invalid.');
  }

  const safetySnapshot = await backupGame(db, settings, gameId, 'pre-restore', { skipRetention: true });
  if (!safetySnapshot) {
    throw new Error('Restore blocked: failed to create safety backup before restore.');
  }

  for (const file of files) {
    const location = locationMap.get(file.location_id);
    if (!location || !location.enabled) {
      continue;
    }

    const sourcePath = resolveSnapshotFileAbsolutePath(snapshot.storage_path, file, manifest);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const destRoot = location.type === 'file' ? path.dirname(location.path) : location.path;
    const destPath = path.resolve(destRoot, file.relative_path);
    assertPathWithinRoot(destRoot, destPath, 'Restore destination path');
    await copyFileWithRetries(sourcePath, destPath, 3);
  }

  logEvent(db, gameId, 'restore', `Snapshot restored (${snapshot.created_at}).`);
}

export async function deleteSnapshot(db: AppDb, snapshotId: string, options: { log?: boolean } = {}): Promise<void> {
  const snapshot = db.state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    return;
  }

  await removeDirSafe(snapshot.storage_path);
  db.state.snapshots = db.state.snapshots.filter((item) => item.id !== snapshotId);
  db.state.snapshotFiles = db.state.snapshotFiles.filter((item) => item.snapshot_id !== snapshotId);
  persistDb(db);

  if (options.log !== false) {
    logEvent(db, snapshot.game_id, 'backup', 'Snapshot deleted.');
  }
}

export async function verifySnapshot(db: AppDb, snapshotId: string): Promise<VerifyResult> {
  const snapshot = db.state.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    throw new Error('Snapshot not found');
  }

  const files = db.state.snapshotFiles.filter((item) => item.snapshot_id === snapshotId);
  const manifest = await readSnapshotManifest(snapshot.storage_path);
  if (!manifest) {
    throw new Error('Snapshot manifest is missing or invalid.');
  }
  let issues = 0;
  for (const file of files) {
    const absolutePath = resolveSnapshotFileAbsolutePath(snapshot.storage_path, file, manifest);
    if (!fs.existsSync(absolutePath)) {
      issues += 1;
      continue;
    }
    const checksum = await hashFile(absolutePath);
    if (checksum !== file.checksum) {
      issues += 1;
    }
  }

  return { ok: issues === 0, issues };
}

async function listFilesForLocation(location: SaveLocation): Promise<string[]> {
  if (location.type === 'file') {
    return [location.path];
  }
  return walkFiles(location.path);
}

function computeSnapshotChecksum(files: SnapshotFile[]): string {
  const payload = files
    .slice()
    .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
    .map((file) => `${file.location_id}:${file.relative_path}:${file.checksum}:${file.size_bytes}`)
    .join('|');
  return hashText(payload);
}

async function applyRetentionPolicy(db: AppDb, settings: Settings, gameId: string): Promise<void> {
  const retentionCount = Math.max(1, settings.retentionCount);
  const snapshots = db.state.snapshots
    .filter((snapshot) => snapshot.game_id === gameId)
    .slice()
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  const toRemove = snapshots.slice(retentionCount);
  for (const snapshot of toRemove) {
    await deleteSnapshot(db, snapshot.id, { log: false });
  }
}

function readGameMetadata(storageRoot: string, gameFolder: string): RecoveredGameMetadata | null {
  const metadataPath = path.join(storageRoot, gameFolder, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(metadataPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Game>;
    const id = typeof parsed.id === 'string' && parsed.id.trim().length > 0 ? parsed.id.trim() : null;
    const name = typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : null;
    const installPath =
      typeof parsed.install_path === 'string' && parsed.install_path.trim().length > 0
        ? parsed.install_path.trim()
        : null;
    const exePath =
      typeof parsed.exe_path === 'string' && parsed.exe_path.trim().length > 0 ? parsed.exe_path.trim() : null;
    if (!id || !name || !installPath || !exePath) {
      return null;
    }

    return {
      gameFolder,
      game: {
        id,
        name,
        install_path: installPath,
        exe_path: exePath,
        created_at:
          typeof parsed.created_at === 'string' && parsed.created_at.trim().length > 0
            ? parsed.created_at
            : new Date().toISOString(),
        last_seen_at: null,
        status: 'warning',
        folder_name: gameFolder
      }
    };
  } catch {
    return null;
  }
}

function buildLocationSeeds(
  gameId: string,
  snapshotFiles: SnapshotFile[],
  manifest: SnapshotManifestPayload
): StoredSaveLocation[] {
  const locationIds = Array.from(new Set(snapshotFiles.map((file) => file.location_id)));
  const seeds: StoredSaveLocation[] = [];
  for (const locationId of locationIds) {
    const manifestLocation = manifest.locations[locationId];
    if (!manifestLocation) continue;
    seeds.push({
      id: locationId,
      game_id: gameId,
      path: manifestLocation.path,
      type: manifestLocation.type,
      auto_detected: manifestLocation.auto_detected,
      enabled: manifestLocation.enabled
    });
  }
  return seeds;
}

async function writeSnapshotManifest(
  snapshotRoot: string,
  snapshot: Snapshot,
  locations: SaveLocation[],
  locationStorageFolders: Map<string, string>
): Promise<void> {
  const payload: SnapshotManifestPayload = {
    version: 2,
    snapshot_id: snapshot.id,
    created_at: snapshot.created_at,
    reason: snapshot.reason,
    locations: {}
  };
  for (const location of locations) {
    const storageFolder = locationStorageFolders.get(location.id) ?? location.id;
    payload.locations[location.id] = {
      path: location.path,
      type: location.type,
      auto_detected: location.auto_detected,
      enabled: location.enabled,
      storage_folder: storageFolder
    };
  }
  const manifestPath = path.join(snapshotRoot, SNAPSHOT_MANIFEST_FILE_NAME);
  await fs.promises.writeFile(manifestPath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function readSnapshotManifest(snapshotRoot: string): Promise<SnapshotManifestPayload | null> {
  const manifestPath = path.join(snapshotRoot, SNAPSHOT_MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SnapshotManifestPayload>;
    if (parsed.version !== 2) {
      return null;
    }
    if (typeof parsed.snapshot_id !== 'string' || parsed.snapshot_id.trim().length === 0) {
      return null;
    }
    if (typeof parsed.created_at !== 'string' || parsed.created_at.trim().length === 0) {
      return null;
    }
    if (
      parsed.reason !== 'auto' &&
      parsed.reason !== 'manual' &&
      parsed.reason !== 'pre-restore'
    ) {
      return null;
    }
    const locations = parsed.locations;
    if (!locations || typeof locations !== 'object') {
      return null;
    }

    const normalized: Record<string, SnapshotManifestLocation> = {};
    for (const [locationId, value] of Object.entries(locations)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<SnapshotManifestLocation>;
      if (
        typeof candidate.path !== 'string' ||
        (candidate.type !== 'file' && candidate.type !== 'folder') ||
        typeof candidate.auto_detected !== 'boolean' ||
        typeof candidate.enabled !== 'boolean' ||
        typeof candidate.storage_folder !== 'string' ||
        candidate.storage_folder.trim().length === 0
      ) {
        continue;
      }
      normalized[locationId] = {
        path: candidate.path,
        type: candidate.type,
        auto_detected: candidate.auto_detected,
        enabled: candidate.enabled,
        storage_folder: candidate.storage_folder.trim()
      };
    }
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }

    return {
      version: 2,
      snapshot_id: parsed.snapshot_id.trim(),
      created_at: createdAt.toISOString(),
      reason: parsed.reason,
      locations: normalized
    };
  } catch {
    return null;
  }
}

function isSamePath(a: string, b: string): boolean {
  const normalizedA = path.resolve(path.normalize(a));
  const normalizedB = path.resolve(path.normalize(b));
  if (process.platform === 'win32') {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}

function isDirectoryPath(targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) {
    return false;
  }
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

async function readDirectoryEntries(targetPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function scanSingleSnapshot(
  gameId: string,
  snapshotPath: string,
  existingSnapshotIds: Set<string>
): Promise<ScannedSnapshotPayload | null> {
  const filesOnDisk = await walkFiles(snapshotPath);
  if (filesOnDisk.length === 0) {
    return null;
  }

  const manifest = await readSnapshotManifest(snapshotPath);
  if (!manifest) {
    return null;
  }
  const manifestFolderMap = createManifestFolderMap(manifest);
  const manifestPath = path.join(snapshotPath, SNAPSHOT_MANIFEST_FILE_NAME);
  const snapshotId = createUniqueSnapshotId(manifest.snapshot_id, existingSnapshotIds);
  const snapshotFiles: SnapshotFile[] = [];
  let totalSize = 0;

  for (const absoluteFilePath of filesOnDisk) {
    if (isSamePath(absoluteFilePath, manifestPath)) {
      continue;
    }
    const parts = parseSnapshotFilePath(snapshotPath, absoluteFilePath, manifestFolderMap);
    if (!parts) {
      continue;
    }
    const fileStats = await fs.promises.stat(absoluteFilePath);
    const checksum = await hashFile(absoluteFilePath);
    snapshotFiles.push({
      id: uuid(),
      snapshot_id: snapshotId,
      location_id: parts.locationId,
      relative_path: parts.relativePath,
      size_bytes: fileStats.size,
      checksum
    });
    totalSize += fileStats.size;
  }

  if (snapshotFiles.length === 0) {
    return null;
  }

  return {
    snapshot: {
      id: snapshotId,
      game_id: gameId,
      created_at: manifest.created_at,
      size_bytes: totalSize,
      checksum: computeSnapshotChecksum(snapshotFiles),
      storage_path: snapshotPath,
      reason: manifest.reason
    },
    files: snapshotFiles,
    locationSeeds: buildLocationSeeds(gameId, snapshotFiles, manifest)
  };
}

function parseSnapshotFilePath(
  snapshotPath: string,
  absoluteFilePath: string,
  manifestFolderMap: Map<string, string>
): { locationId: string; relativePath: string } | null {
  const relative = path.relative(snapshotPath, absoluteFilePath);
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const locationFolder = segments[0];
  const remainingPath = segments.slice(1);
  if (!locationFolder || remainingPath.length === 0) {
    return null;
  }
  const locationId = resolveLocationIdFromFolder(locationFolder, manifestFolderMap);
  if (!locationId) {
    return null;
  }

  return {
    locationId,
    relativePath: path.join(...remainingPath)
  };
}

function resolveLocationIdFromFolder(locationFolder: string, manifestFolderMap: Map<string, string>): string | null {
  const exact = manifestFolderMap.get(locationFolder);
  if (exact) {
    return exact;
  }
  const byLower = manifestFolderMap.get(locationFolder.toLowerCase());
  if (byLower) {
    return byLower;
  }
  return null;
}

function createManifestFolderMap(manifest: SnapshotManifestPayload): Map<string, string> {
  const folderMap = new Map<string, string>();
  for (const [locationId, location] of Object.entries(manifest.locations)) {
    const storageFolder = location.storage_folder.trim();
    folderMap.set(storageFolder, locationId);
    folderMap.set(storageFolder.toLowerCase(), locationId);
  }

  return folderMap;
}

function createUniqueSnapshotId(preferredId: string, existingSnapshotIds: Set<string>): string {
  const trimmed = preferredId.trim();
  if (trimmed.length > 0 && !existingSnapshotIds.has(trimmed)) {
    return trimmed;
  }

  let generated = uuid();
  while (existingSnapshotIds.has(generated)) {
    generated = uuid();
  }
  return generated;
}

function normalizePathForKey(targetPath: string): string {
  const normalized = path.resolve(path.normalize(targetPath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveUniqueSnapshotFolderName(storageRoot: string, gameFolder: string, createdAt: string): string {
  const base = formatSnapshotTimestamp(createdAt);
  let candidate = base;
  let suffix = 2;
  while (isDirectoryPath(getSnapshotRoot(storageRoot, gameFolder, candidate))) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function formatSnapshotTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  const timestamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const year = timestamp.getFullYear();
  const month = pad2(timestamp.getMonth() + 1);
  const day = pad2(timestamp.getDate());
  const hour = pad2(timestamp.getHours());
  const minute = pad2(timestamp.getMinutes());
  const second = pad2(timestamp.getSeconds());
  const millis = pad3(timestamp.getMilliseconds());
  return `${year}-${month}-${day}_${hour}-${minute}-${second}-${millis}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function pad3(value: number): string {
  return value.toString().padStart(3, '0');
}

function buildLocationStorageFolders(locations: SaveLocation[]): Map<string, string> {
  const folders = new Map<string, string>();
  const used = new Set<string>();
  for (const location of locations) {
    const base = resolveLocationStorageFolderBase(location);
    const unique = ensureUniqueFolderName(base, used);
    folders.set(location.id, unique);
  }
  return folders;
}

function resolveLocationStorageFolderBase(location: SaveLocation): string {
  const trimmed = location.path.replace(/[\\/]+$/, '');
  const name = path.basename(trimmed);
  const fallback = location.type === 'file' ? 'File' : 'Folder';
  const safe = toSafeGameFolderName(name || fallback);
  return safe.length > 0 ? safe : fallback;
}

function ensureUniqueFolderName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function resolveSnapshotFileAbsolutePath(
  snapshotRoot: string,
  file: SnapshotFile,
  manifest: SnapshotManifestPayload
): string {
  const storageFolder = manifest?.locations?.[file.location_id]?.storage_folder;
  if (!storageFolder || storageFolder.trim().length === 0) {
    throw new Error(`Snapshot manifest is missing storage mapping for location "${file.location_id}".`);
  }
  const absolutePath = path.resolve(snapshotRoot, storageFolder, file.relative_path);
  assertPathWithinRoot(snapshotRoot, absolutePath, 'Snapshot file path');
  return absolutePath;
}

function assertPathWithinRoot(rootPath: string, targetPath: string, context: string): void {
  const normalizedRoot = normalizePathForKey(rootPath);
  const normalizedTarget = normalizePathForKey(targetPath);
  const normalizedRootWithSeparator = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  if (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(normalizedRootWithSeparator)
  ) {
    return;
  }
  throw new Error(`${context} resolves outside its allowed root.`);
}
