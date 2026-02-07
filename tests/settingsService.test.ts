import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ElectronAppMock {
  getPath: (name: string) => string;
}

const tempRoots: string[] = [];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unmock('electron');
  while (tempRoots.length > 0) {
    const next = tempRoots.pop();
    if (!next) continue;
    fs.rmSync(next, { recursive: true, force: true });
  }
});

describe('settingsService', () => {
  it('keeps current settings when storage migration fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-settings-'));
    tempRoots.push(root);
    const dataRoot = path.join(root, 'DataRoot');
    const userDataPath = path.join(dataRoot, 'AppState');
    const appMock: ElectronAppMock = {
      getPath: (name: string) => {
        if (name === 'userData') return userDataPath;
        throw new Error(`Unhandled app path: ${name}`);
      }
    };

    vi.doMock('electron', () => ({ app: appMock }));
    const service = await import('../src/main/services/settingsService');
    const initial = service.loadSettings();

    const sourceFile = path.join(initial.storageRoot, 'seed.dat');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'seed', 'utf-8');

    const targetStorage = path.join(root, 'BrokenMoveTarget');
    vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('rename-failed'));
    vi.spyOn(fs.promises, 'cp').mockRejectedValue(new Error('copy-failed'));

    await expect(service.updateSettings({ storageRoot: targetStorage })).rejects.toThrow(
      'Failed to migrate storage root'
    );

    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataPath, 'settings.json'), 'utf-8')
    ) as { storageRoot: string };
    expect(persisted.storageRoot).toBe(initial.storageRoot);
    expect(fs.existsSync(sourceFile)).toBe(true);
  });
});
