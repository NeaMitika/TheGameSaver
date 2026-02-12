/// <reference types="vite/client" />

import type {
  AddGamePayload,
  BackupProgressPayload,
  BackupScanResult,
  CatalogDetectionProgressPayload,
  Game,
  GameDetail,
  GameSummary,
  Settings,
  SnapshotCreatedPayload,
  StartupState,
  VerifyResult,
  SaveLocation
} from '@shared/types';

declare global {
  interface Window {
    gamesaver: {
      listGames: () => Promise<GameSummary[]>;
      getGame: (gameId: string) => Promise<GameDetail>;
      addGame: (payload: AddGamePayload) => Promise<Game>;
      removeGame: (gameId: string) => Promise<void>;
      launchGame: (gameId: string) => Promise<void>;
      addSaveLocation: (gameId: string, locationPath: string) => Promise<SaveLocation>;
      toggleSaveLocation: (id: string, enabled: boolean) => Promise<void>;
      removeSaveLocation: (id: string) => Promise<void>;
      backupNow: (gameId: string) => Promise<void>;
      scanBackups: () => Promise<BackupScanResult>;
      restoreSnapshot: (snapshotId: string) => Promise<void>;
      verifySnapshot: (snapshotId: string) => Promise<VerifyResult>;
      deleteSnapshot: (snapshotId: string) => Promise<void>;
      getSettings: () => Promise<Settings>;
      updateSettings: (payload: Partial<Settings>) => Promise<Settings>;
      pickExe: () => Promise<string | null>;
      pickFolder: () => Promise<string | null>;
      pickSaveLocation: () => Promise<string | null>;
      onGameStatus: (callback: (payload: { gameId: string; isRunning: boolean }) => void) => () => void;
      onBackupCreated: (callback: (payload: SnapshotCreatedPayload) => void) => () => void;
      onBackupProgress: (callback: (payload: BackupProgressPayload) => void) => () => void;
      onCatalogDetectionProgress: (callback: (payload: CatalogDetectionProgressPayload) => void) => () => void;
      windowControls: {
        minimize: () => Promise<void>;
        toggleMaximize: () => Promise<boolean>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        getLayoutMode: () => Promise<'normal' | 'widget'>;
        setLayoutMode: (mode: 'normal' | 'widget') => Promise<'normal' | 'widget'>;
        onWindowState: (callback: (payload: { isMaximized: boolean }) => void) => () => void;
      };
      relaunchApp: () => Promise<void>;
      getStartupState: () => Promise<StartupState>;
      onRestartRequired: (callback: () => void) => () => void;
    };
  }
}

export {};
