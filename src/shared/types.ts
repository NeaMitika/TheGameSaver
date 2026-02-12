export type GameStatus = 'protected' | 'warning' | 'error';
export type SaveLocationType = 'folder' | 'file';
export type SnapshotReason = 'auto' | 'manual' | 'pre-restore';
export type EventLogType = 'backup' | 'restore' | 'error';

export interface Game {
  id: string;
  name: string;
  install_path: string;
  exe_path: string;
  created_at: string;
  last_seen_at: string | null;
  status: GameStatus;
}

export interface SaveLocation {
  id: string;
  game_id: string;
  path: string;
  type: SaveLocationType;
  auto_detected: boolean;
  enabled: boolean;
  exists: boolean;
}

export interface Snapshot {
  id: string;
  game_id: string;
  created_at: string;
  size_bytes: number;
  checksum: string;
  storage_path: string;
  reason: SnapshotReason;
}

export interface SnapshotFile {
  id: string;
  snapshot_id: string;
  location_id: string;
  relative_path: string;
  size_bytes: number;
  checksum: string;
}

export interface EventLog {
  id: string;
  game_id: string | null;
  type: EventLogType;
  message: string;
  created_at: string;
}

export interface Settings {
  backupFrequencyMinutes: number;
  retentionCount: number;
  storageRoot: string;
  compressionEnabled: boolean;
  dataRoot: string;
}

export interface StartupState {
  recoveryMode: boolean;
  reason: string | null;
  missingPath: string | null;
}

export interface GameSummary extends Game {
  last_backup_at: string | null;
  last_snapshot_reason: SnapshotReason | null;
  issue_count: number;
  is_running: boolean;
  exe_icon?: string | null;
}

export interface GameDetail {
  game: Game;
  saveLocations: SaveLocation[];
  snapshots: Snapshot[];
  eventLogs: EventLog[];
}

export interface AddGamePayload {
  name: string;
  exePath: string;
  installPath: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: number;
}

export interface BackupScanResult {
  addedSnapshots: number;
  removedSnapshots: number;
  removedSnapshotFiles: number;
  skippedUnknownGames: number;
  skippedInvalidSnapshots: number;
}

export interface SnapshotCreatedPayload {
  gameId: string;
  snapshotId: string;
  reason: SnapshotReason;
  createdAt: string;
}

export type BackupProgressStage = 'started' | 'progress' | 'completed' | 'failed';
export type CatalogDetectionProgressStage = 'started' | 'progress' | 'completed' | 'failed';

export interface CatalogDetectionTitleMatchScore {
  title: string;
  score: number;
}

export interface CatalogDetectionDebugPayload {
  exeProductName: string | null;
  exeFileDescription: string | null;
  queryStrings: string[];
  topTitleMatches: CatalogDetectionTitleMatchScore[];
  windowsLocations: string[];
  currentLocation: string | null;
  expandedPaths: string[];
  checkedPathSamples: string[];
  selectedCandidatePath: string | null;
  selectedCandidateScore: number | null;
  selectedCandidateReasons: string[];
}

export interface BackupProgressPayload {
  gameId: string;
  reason: SnapshotReason;
  stage: BackupProgressStage;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  copiedBytes: number;
  percent: number;
  snapshotId: string | null;
  createdAt: string | null;
  message: string | null;
}

export interface CatalogDetectionProgressPayload {
  gameId: string;
  gameName: string;
  stage: CatalogDetectionProgressStage;
  percent: number;
  processed: number;
  total: number;
  message: string;
  matchedTitle: string | null;
  resolvedPath: string | null;
  debug?: CatalogDetectionDebugPayload | null;
}
