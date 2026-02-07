import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '../src/main/services/db';
import { Settings } from '../src/shared/types';

vi.mock('../src/main/services/saveLocationService', () => ({
  listSaveLocations: vi.fn()
}));

vi.mock('../src/main/services/storage', () => ({
  getSnapshotRoot: vi.fn(() => path.join('tmp', 'snapshot-root')),
  ensureDir: vi.fn(),
  toSafeGameFolderName: vi.fn((name: string) => name)
}));

vi.mock('../src/main/services/fileOps', () => ({
  copyFileWithRetries: vi.fn(),
  walkFiles: vi.fn(),
  removeDirSafe: vi.fn(async () => undefined)
}));

vi.mock('../src/main/services/hash', () => ({
  hashFile: vi.fn(),
  hashText: vi.fn(() => 'snapshot-checksum')
}));

vi.mock('../src/main/services/eventLogService', () => ({
  logEvent: vi.fn()
}));

vi.mock('../src/main/services/gameService', () => ({
  updateGameStatus: vi.fn(),
  getStoredGameById: vi.fn((db: { state?: { games?: Array<{ id: string }> } }, gameId: string) =>
    db.state?.games?.find((game) => game.id === gameId)
  )
}));

import { backupGame, deleteSnapshot, restoreSnapshot } from '../src/main/services/backupService';
import { logEvent } from '../src/main/services/eventLogService';
import { removeDirSafe, walkFiles } from '../src/main/services/fileOps';
import { updateGameStatus } from '../src/main/services/gameService';
import { hashFile } from '../src/main/services/hash';
import { listSaveLocations } from '../src/main/services/saveLocationService';
import { getSnapshotRoot } from '../src/main/services/storage';

const settings: Settings = {
  backupFrequencyMinutes: 5,
  retentionCount: 10,
  storageRoot: path.join('tmp', 'storage'),
  compressionEnabled: false,
  dataRoot: path.join('tmp', 'data')
};

const tempRoots: string[] = [];

describe('backupService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  afterEach(() => {
    while (tempRoots.length > 0) {
      const next = tempRoots.pop();
      if (!next) continue;
      fs.rmSync(next, { recursive: true, force: true });
    }
  });

  it('marks warning and skips when no enabled save locations exist', async () => {
    vi.mocked(listSaveLocations).mockReturnValue([]);
    const db = createMemoryDb({
      games: [
        {
          id: 'game-1',
          name: 'Game One',
          install_path: 'C:\\Games\\One',
          exe_path: 'C:\\Games\\One\\one.exe',
          created_at: new Date().toISOString(),
          last_seen_at: null,
          status: 'protected',
          folder_name: 'game-1'
        }
      ]
    });

    const snapshot = await backupGame(db, settings, 'game-1', 'manual');

    expect(snapshot).toBeNull();
    const snapshotFolderArg = vi.mocked(getSnapshotRoot).mock.calls[0]?.[2];
    expect(snapshotFolderArg).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}(?:_\d+)?$/);
    expect(updateGameStatus).toHaveBeenCalledWith(db, 'game-1', 'warning');
    expect(logEvent).toHaveBeenCalledWith(db, 'game-1', 'error', 'Backup skipped: no enabled save locations.');
    expect(removeDirSafe).not.toHaveBeenCalled();
  });

  it('does not persist empty snapshots when enabled locations have no files', async () => {
    vi.mocked(listSaveLocations).mockReturnValue([
      {
        id: 'loc-1',
        game_id: 'game-1',
        path: 'C:\\Saves',
        type: 'folder',
        auto_detected: false,
        enabled: true,
        exists: true
      }
    ]);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(walkFiles).mockResolvedValue([]);
    const db = createMemoryDb({
      games: [
        {
          id: 'game-1',
          name: 'Game One',
          install_path: 'C:\\Games\\One',
          exe_path: 'C:\\Games\\One\\one.exe',
          created_at: new Date().toISOString(),
          last_seen_at: null,
          status: 'protected',
          folder_name: 'game-1'
        }
      ]
    });

    const snapshot = await backupGame(db, settings, 'game-1', 'manual');

    expect(snapshot).toBeNull();
    expect(updateGameStatus).toHaveBeenCalledWith(db, 'game-1', 'warning');
    expect(logEvent).toHaveBeenCalledWith(
      db,
      'game-1',
      'error',
      'Backup skipped: no files found in enabled save locations.'
    );
    expect(removeDirSafe).toHaveBeenCalledWith(path.join('tmp', 'snapshot-root'));
  });

  it('fails and rolls back when writing the snapshot manifest fails', async () => {
    vi.mocked(listSaveLocations).mockReturnValue([
      {
        id: 'loc-1',
        game_id: 'game-1',
        path: 'C:\\Saves\\profile.sav',
        type: 'file',
        auto_detected: false,
        enabled: true,
        exists: true
      }
    ]);
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 12 } as fs.Stats);
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('disk full'));
    vi.mocked(hashFile).mockResolvedValue('file-checksum');

    const db = createMemoryDb({
      games: [
        {
          id: 'game-1',
          name: 'Game One',
          install_path: 'C:\\Games\\One',
          exe_path: 'C:\\Games\\One\\one.exe',
          created_at: new Date().toISOString(),
          last_seen_at: null,
          status: 'protected',
          folder_name: 'game-1'
        }
      ]
    });

    await expect(backupGame(db, settings, 'game-1', 'manual')).rejects.toThrow('disk full');
    expect(db.state.snapshots).toHaveLength(0);
    expect(db.state.snapshotFiles).toHaveLength(0);
    expect(removeDirSafe).toHaveBeenCalledWith(path.join('tmp', 'snapshot-root'));

    existsSpy.mockRestore();
    statSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('rejects verification when snapshot manifest is missing', async () => {
    const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-snapshot-missing-manifest-'));
    tempRoots.push(snapshotRoot);
    const db = createMemoryDb({
      snapshots: [
        {
          id: 'snap-1',
          game_id: 'game-1',
          created_at: new Date().toISOString(),
          size_bytes: 1,
          checksum: 'snapshot-checksum',
          storage_path: snapshotRoot,
          reason: 'manual'
        }
      ],
      snapshotFiles: [
        {
          id: 'file-1',
          snapshot_id: 'snap-1',
          location_id: 'loc-1',
          relative_path: 'save.sav',
          size_bytes: 1,
          checksum: 'file-checksum'
        }
      ]
    });

    const { verifySnapshot } = await import('../src/main/services/backupService');
    await expect(verifySnapshot(db, 'snap-1')).rejects.toThrow('Snapshot manifest is missing or invalid.');
  });

  it('blocks verification when manifest paths escape snapshot root', async () => {
    const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-snapshot-traversal-'));
    tempRoots.push(snapshotRoot);
    fs.writeFileSync(
      path.join(snapshotRoot, 'snapshot.manifest.json'),
      JSON.stringify(
        {
          version: 2,
          snapshot_id: 'snap-1',
          created_at: new Date().toISOString(),
          reason: 'manual',
          locations: {
            'loc-1': {
              path: 'C:\\Saves',
              type: 'folder',
              auto_detected: false,
              enabled: true,
              storage_folder: '..\\..\\outside'
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    );

    const db = createMemoryDb({
      snapshots: [
        {
          id: 'snap-1',
          game_id: 'game-1',
          created_at: new Date().toISOString(),
          size_bytes: 1,
          checksum: 'snapshot-checksum',
          storage_path: snapshotRoot,
          reason: 'manual'
        }
      ],
      snapshotFiles: [
        {
          id: 'file-1',
          snapshot_id: 'snap-1',
          location_id: 'loc-1',
          relative_path: 'save.sav',
          size_bytes: 1,
          checksum: 'file-checksum'
        }
      ]
    });

    const { verifySnapshot } = await import('../src/main/services/backupService');
    await expect(verifySnapshot(db, 'snap-1')).rejects.toThrow(
      'Snapshot file path resolves outside its allowed root.'
    );
  });

  it('blocks restore when pre-restore safety snapshot cannot be created', async () => {
    const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-restore-safety-block-'));
    tempRoots.push(snapshotRoot);
    fs.writeFileSync(
      path.join(snapshotRoot, 'snapshot.manifest.json'),
      JSON.stringify(
        {
          version: 2,
          snapshot_id: 'snap-1',
          created_at: new Date().toISOString(),
          reason: 'manual',
          locations: {}
        },
        null,
        2
      ),
      'utf-8'
    );
    vi.mocked(listSaveLocations).mockReturnValue([]);

    const db = createMemoryDb({
      games: [
        {
          id: 'game-1',
          name: 'Game One',
          install_path: 'C:\\Games\\One',
          exe_path: 'C:\\Games\\One\\one.exe',
          created_at: new Date().toISOString(),
          last_seen_at: null,
          status: 'protected',
          folder_name: 'game-1'
        }
      ],
      snapshots: [
        {
          id: 'snap-1',
          game_id: 'game-1',
          created_at: new Date().toISOString(),
          size_bytes: 0,
          checksum: 'snapshot-checksum',
          storage_path: snapshotRoot,
          reason: 'manual'
        }
      ]
    });

    await expect(restoreSnapshot(db, settings, 'snap-1')).rejects.toThrow(
      'Restore blocked: failed to create safety backup before restore.'
    );
  });

  it('keeps snapshot metadata when disk deletion fails', async () => {
    vi.mocked(removeDirSafe).mockRejectedValueOnce(new Error('locked'));
    const db = createMemoryDb({
      snapshots: [
        {
          id: 'snap-1',
          game_id: 'game-1',
          created_at: new Date().toISOString(),
          size_bytes: 1,
          checksum: 'snapshot-checksum',
          storage_path: 'C:\\Backups\\Game\\Snapshots\\snap-1',
          reason: 'manual'
        }
      ],
      snapshotFiles: [
        {
          id: 'file-1',
          snapshot_id: 'snap-1',
          location_id: 'loc-1',
          relative_path: 'save.sav',
          size_bytes: 1,
          checksum: 'file-checksum'
        }
      ]
    });

    await expect(deleteSnapshot(db, 'snap-1')).rejects.toThrow('locked');
    expect(db.state.snapshots).toHaveLength(1);
    expect(db.state.snapshotFiles).toHaveLength(1);
  });
});
