import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCatalogSavePaths } from '../src/main/services/catalogSaveDetectionService';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const next = tempRoots.pop();
    if (!next) continue;
    fs.rmSync(next, { recursive: true, force: true });
  }
});

describe('catalogSaveDetectionService', () => {
  it('matches by exe metadata and resolves <path-to-game> locations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Age of Empires III Definitive Edition');
    const savePath = path.join(installPath, 'SaveData');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'profile.sav'), 'save-data', 'utf-8');

    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'AoE3DE_s',
        exePath: path.join(installPath, 'AoE3DE_s.exe'),
        installPath
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Age of Empires III Definitive Edition',
            saveLocations: [
              {
                system: 'Windows',
                location: '<path-to-game>\\SaveData'
              }
            ]
          }
        ],
        readExeMetadata: async () => ({
          productName: 'Age of Empires III Definitive Edition',
          fileDescription: 'Age of Empires III: Definitive Edition'
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.matchedTitle).toBe('Age of Empires III Definitive Edition');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.path).toBe(path.normalize(savePath));
  });

  it('resolves registry locations into real save paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const userProfile = path.join(root, 'User');
    const docsSavePath = path.join(userProfile, 'Documents', 'My Games', 'Game One');
    fs.mkdirSync(docsSavePath, { recursive: true });
    fs.writeFileSync(path.join(docsSavePath, 'slot1.dat'), 'save-data', 'utf-8');

    const previousUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = userProfile;

    try {
      const result = await detectCatalogSavePaths(
        {
          catalogPath: path.join(root, 'missing.json'),
          gameName: 'Game One',
          exePath: path.join(root, 'GameOne.exe'),
          installPath: path.join(root, 'Install')
        },
        {
          loadCatalogEntries: async () => [
            {
              title: 'Game One',
              saveLocations: [
                {
                  system: 'Windows',
                  location: 'HKEY_CURRENT_USER\\SOFTWARE\\Vendor\\GameOne'
                }
              ]
            }
          ],
          readExeMetadata: async () => ({
            productName: 'Game One',
            fileDescription: null
          }),
          readRegistryValues: async () => ['%USERPROFILE%\\Documents\\My Games\\Game One'],
          listSteamLibraries: async () => []
        }
      );

      expect(result.status).toBe('matched');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.source).toBe('registry');
      expect(result.candidates[0]?.path).toBe(path.normalize(docsSavePath));
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });

  it('flags ambiguous title matches when top scores are too close', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Install');
    const savePath = path.join(installPath, 'Saves');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'slot.sav'), 'save-data', 'utf-8');

    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'Age of Empires Definitive Edition',
        exePath: path.join(installPath, 'aoe.exe'),
        installPath
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Age of Empires III Definitive Edition',
            saveLocations: [{ system: 'Windows', location: '<path-to-game>\\Saves' }]
          },
          {
            title: 'Age of Empires II Definitive Edition',
            saveLocations: [{ system: 'Windows', location: '<path-to-game>\\Nope' }]
          }
        ],
        readExeMetadata: async () => ({
          productName: 'Age of Empires Definitive Edition',
          fileDescription: null
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.titleAmbiguous).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('reports real progress counts while scanning windows locations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Install');
    const saveA = path.join(root, 'SavesA');
    const saveB = path.join(root, 'SavesB');
    fs.mkdirSync(saveA, { recursive: true });
    fs.mkdirSync(saveB, { recursive: true });
    fs.writeFileSync(path.join(saveA, 'slot1.sav'), 'a', 'utf-8');
    fs.writeFileSync(path.join(saveB, 'slot2.sav'), 'b', 'utf-8');

    const progressEvents: Array<{ processed: number; total: number }> = [];

    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'Game With Two Locations',
        exePath: path.join(installPath, 'game.exe'),
        installPath,
        onProgress: (progress) => {
          progressEvents.push({ processed: progress.processed, total: progress.total });
        }
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Game With Two Locations',
            saveLocations: [
              { system: 'Windows', location: saveA },
              { system: 'Windows', location: saveB }
            ]
          }
        ],
        readExeMetadata: async () => ({
          productName: 'Game With Two Locations',
          fileDescription: null
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(progressEvents.some((event) => event.total === 2)).toBe(true);
    expect(progressEvents.some((event) => event.processed === 2 && event.total === 2)).toBe(true);
  });

  it('returns debug details for title match and checked paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Install');
    const savePath = path.join(root, 'User', 'Documents', 'GameDebug');
    const missingPath = path.join(root, 'Missing', 'GameDebug');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'slot1.sav'), 'save-data', 'utf-8');

    const progressDebugSnapshots: Array<{ currentLocation: string | null; checkedPathSamples: string[] }> = [];
    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'Game Debug',
        exePath: path.join(installPath, 'GameDebug.exe'),
        installPath,
        onProgress: (progress) => {
          if (progress.debug) {
            progressDebugSnapshots.push({
              currentLocation: progress.debug.currentLocation,
              checkedPathSamples: [...progress.debug.checkedPathSamples]
            });
          }
        }
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Game Debug',
            saveLocations: [
              { system: 'Windows', location: savePath },
              { system: 'Windows', location: missingPath }
            ]
          }
        ],
        readExeMetadata: async () => ({
          productName: 'Game Debug',
          fileDescription: 'Game Debug Description'
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.debug?.queryStrings).toContain('Game Debug');
    expect(result.debug?.exeProductName).toBe('Game Debug');
    expect(result.debug?.topTitleMatches[0]?.title).toBe('Game Debug');
    expect(result.debug?.windowsLocations).toEqual([savePath, missingPath]);
    expect(result.debug?.checkedPathSamples.some((item) => item.startsWith('exists: '))).toBe(true);
    expect(result.debug?.checkedPathSamples.some((item) => item.startsWith('missing: '))).toBe(true);
    expect(result.debug?.selectedCandidatePath).toBe(path.normalize(savePath));
    expect(progressDebugSnapshots.some((item) => item.currentLocation !== null)).toBe(true);
  });

  it('loads catalog entries from top-level games array wrapper', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const catalogPath = path.join(root, 'games-db.json');
    const installPath = path.join(root, 'GameInstall');
    const savePath = path.join(installPath, 'Saves');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'slot.sav'), 'save-data', 'utf-8');

    fs.writeFileSync(
      catalogPath,
      JSON.stringify(
        {
          source: 'PCGamingWiki',
          count: 1,
          games: [
            {
              title: 'Wrapped Game',
              save_game_data_locations: [{ system: 'Windows', location: '<path-to-game>\\Saves' }]
            }
          ]
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await detectCatalogSavePaths(
      {
        catalogPath,
        gameName: 'Wrapped Game',
        exePath: path.join(installPath, 'wrapped.exe'),
        installPath
      },
      {
        readExeMetadata: async () => ({
          productName: 'Wrapped Game',
          fileDescription: null
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.candidates[0]?.path).toBe(path.normalize(savePath));
  });

  it('matches by install folder name when exe metadata is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Age of Empires III Definitive Edition');
    const savePath = path.join(installPath, 'Saves');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'slot.sav'), 'save-data', 'utf-8');

    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'AoE3DE_s',
        exePath: path.join(installPath, 'AoE3DE_s.exe'),
        installPath
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Age of Empires III: Definitive Edition',
            saveLocations: [{ system: 'Windows', location: '<path-to-game>\\Saves' }]
          }
        ],
        readExeMetadata: async () => null,
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.matchedTitle).toBe('Age of Empires III: Definitive Edition');
    expect(result.candidates[0]?.path).toBe(path.normalize(savePath));
  });

  it('resolves <user-id> templates using environment variables and wildcard folder matching', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const userProfile = path.join(root, 'User');
    const installPath = path.join(root, 'Install');
    const numericSavePath = path.join(userProfile, 'Games', 'Age of Empires 3 DE', '76561197960267366', 'Savegame');
    const shortSavePath = path.join(userProfile, 'Games', 'Age of Empires 3 DE', 'A', 'Savegame');
    fs.mkdirSync(numericSavePath, { recursive: true });
    fs.mkdirSync(shortSavePath, { recursive: true });
    fs.writeFileSync(path.join(numericSavePath, 'slot1.sav'), 'save-data', 'utf-8');
    fs.writeFileSync(path.join(shortSavePath, 'slot2.sav'), 'save-data', 'utf-8');

    const previousUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = userProfile;

    try {
      const result = await detectCatalogSavePaths(
        {
          catalogPath: path.join(root, 'missing.json'),
          gameName: 'AoE3DE_s',
          exePath: path.join(installPath, 'AoE3DE_s.exe'),
          installPath
        },
        {
          loadCatalogEntries: async () => [
            {
              title: 'Age of Empires III: Definitive Edition',
              saveLocations: [
                {
                  system: 'Windows',
                  location: '%USERPROFILE%\\Games\\Age of Empires 3 DE\\<user-id>\\Savegame'
                }
              ]
            }
          ],
          readExeMetadata: async () => ({
            productName: 'Age of Empires III: Definitive Edition',
            fileDescription: 'Age of Empires III: Definitive Edition'
          }),
          listSteamLibraries: async () => []
        }
      );

      expect(result.status).toBe('matched');
      expect(result.candidates.some((candidate) => candidate.path === path.normalize(numericSavePath))).toBe(true);
      expect(result.candidates.some((candidate) => candidate.path === path.normalize(shortSavePath))).toBe(true);
    } finally {
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });

  it('splits composite <path-to-game> location strings into independent candidate paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'CompositeInstall');
    const preferencesPath = path.join(installPath, 'preferences');
    const savesPath = path.join(installPath, 'saves');
    fs.mkdirSync(preferencesPath, { recursive: true });
    fs.mkdirSync(savesPath, { recursive: true });
    fs.writeFileSync(path.join(preferencesPath, 'profile.cfg'), 'pref', 'utf-8');
    fs.writeFileSync(path.join(savesPath, 'slot1.sav'), 'save', 'utf-8');

    const result = await detectCatalogSavePaths(
      {
        catalogPath: path.join(root, 'missing.json'),
        gameName: 'Composite Game',
        exePath: path.join(installPath, 'composite.exe'),
        installPath
      },
      {
        loadCatalogEntries: async () => [
          {
            title: 'Composite Game',
            saveLocations: [
              {
                system: 'Windows',
                location:
                  '<path-to-game>\\betaPreferences\\ <path-to-game>\\preferences\\ <path-to-game>\\runs\\ <path-to-game>\\saves\\'
              }
            ]
          }
        ],
        readExeMetadata: async () => ({
          productName: 'Composite Game',
          fileDescription: null
        }),
        listSteamLibraries: async () => []
      }
    );

    expect(result.status).toBe('matched');
    expect(result.debug?.windowsLocations).toEqual([
      '<path-to-game>\\betaPreferences\\',
      '<path-to-game>\\preferences\\',
      '<path-to-game>\\runs\\',
      '<path-to-game>\\saves\\'
    ]);
    expect(result.candidates.some((candidate) => candidate.path === path.normalize(preferencesPath))).toBe(true);
    expect(result.candidates.some((candidate) => candidate.path === path.normalize(savesPath))).toBe(true);
  });

  it('splits composite %APPDATA% location strings into independent candidate paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesaver-catalog-'));
    tempRoots.push(root);
    const installPath = path.join(root, 'Install');
    const appDataRoot = path.join(root, 'AppData');
    const cloudPath = path.join(appDataRoot, 'MyGame', 'Cloud');
    const savesPath = path.join(appDataRoot, 'MyGame', 'Saves');
    fs.mkdirSync(cloudPath, { recursive: true });
    fs.mkdirSync(savesPath, { recursive: true });
    fs.writeFileSync(path.join(cloudPath, 'settings.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(savesPath, 'slot1.sav'), 'save', 'utf-8');

    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = appDataRoot;

    try {
      const result = await detectCatalogSavePaths(
        {
          catalogPath: path.join(root, 'missing.json'),
          gameName: 'AppData Composite',
          exePath: path.join(installPath, 'game.exe'),
          installPath
        },
        {
          loadCatalogEntries: async () => [
            {
              title: 'AppData Composite',
              saveLocations: [
                {
                  system: 'Windows',
                  location: '%APPDATA%\\MyGame\\Cloud\\ %APPDATA%\\MyGame\\Saves\\'
                }
              ]
            }
          ],
          readExeMetadata: async () => ({
            productName: 'AppData Composite',
            fileDescription: null
          }),
          listSteamLibraries: async () => []
        }
      );

      expect(result.status).toBe('matched');
      expect(result.debug?.windowsLocations).toEqual(['%APPDATA%\\MyGame\\Cloud\\', '%APPDATA%\\MyGame\\Saves\\']);
      expect(result.candidates.some((candidate) => candidate.path === path.normalize(cloudPath))).toBe(true);
      expect(result.candidates.some((candidate) => candidate.path === path.normalize(savesPath))).toBe(true);
    } finally {
      if (previousAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = previousAppData;
      }
    }
  });
});
