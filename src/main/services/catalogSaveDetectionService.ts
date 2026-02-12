import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 1024 * 1024 * 8;
const COMMAND_TIMEOUT_MS = 4000;
const SAVE_FILE_EXTENSIONS = new Set(['.sav', '.save', '.dat', '.profile', '.json', '.ini', '.cfg']);

type DetectionStatus =
  | 'catalog-missing'
  | 'catalog-invalid'
  | 'no-match'
  | 'no-windows-locations'
  | 'no-valid-candidates'
  | 'matched';

type RegistryRoot = 'HKEY_CURRENT_USER' | 'HKEY_LOCAL_MACHINE';

interface CatalogLocation {
  system?: unknown;
  location?: unknown;
}

interface CatalogEntry {
  title?: unknown;
  save_game_data_locations?: unknown;
}

interface ParsedCatalogEntry {
  title: string;
  saveLocations: Array<{ system: string; location: string }>;
}

export interface ExeMetadata {
  productName: string | null;
  fileDescription: string | null;
}

export interface CatalogSavePathCandidate {
  path: string;
  score: number;
  source: 'filesystem' | 'registry';
  rawLocation: string;
  reasons: string[];
}

export interface CatalogTitleMatchScore {
  title: string;
  score: number;
}

export interface CatalogSaveDetectionDebugInfo {
  exeProductName: string | null;
  exeFileDescription: string | null;
  queryStrings: string[];
  topTitleMatches: CatalogTitleMatchScore[];
  windowsLocations: string[];
  currentLocation: string | null;
  expandedPaths: string[];
  checkedPathSamples: string[];
  selectedCandidatePath: string | null;
  selectedCandidateScore: number | null;
  selectedCandidateReasons: string[];
}

export interface CatalogSaveDetectionProgress {
  percent: number;
  processed: number;
  total: number;
  message: string;
  matchedTitle: string | null;
  debug?: CatalogSaveDetectionDebugInfo;
}

export interface CatalogSaveDetectionResult {
  status: DetectionStatus;
  matchedTitle: string | null;
  matchScore: number;
  titleAmbiguous: boolean;
  candidates: CatalogSavePathCandidate[];
  metadata: ExeMetadata | null;
  warnings: string[];
  debug?: CatalogSaveDetectionDebugInfo;
}

export interface CatalogSaveDetectionInput {
  catalogPath: string;
  gameName: string;
  exePath: string;
  installPath: string;
  onProgress?: (progress: CatalogSaveDetectionProgress) => void;
}

interface CatalogCacheEntry {
  mtimeMs: number;
  entries: ParsedCatalogEntry[];
}

export interface CatalogDetectionAdapters {
  readExeMetadata?: (exePath: string) => Promise<ExeMetadata | null>;
  readRegistryValues?: (registryKey: string) => Promise<string[]>;
  listSteamLibraries?: () => Promise<string[]>;
  loadCatalogEntries?: (catalogPath: string) => Promise<ParsedCatalogEntry[] | null>;
}

interface ResolveContext {
  installPath: string;
  gameName: string;
  steamLibraries: string[];
}

const catalogCache = new Map<string, CatalogCacheEntry>();
const MAX_DEBUG_PATH_SAMPLES = 40;
const LOCATION_SPLIT_START_PATTERN =
  /<[^>]+>|%[^%]+%|(?:HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE|HKCU|HKLM)\\|[A-Za-z]:\\/gi;

export async function detectCatalogSavePaths(
  input: CatalogSaveDetectionInput,
  adapters: CatalogDetectionAdapters = {}
): Promise<CatalogSaveDetectionResult> {
  const warnings: string[] = [];
  const debug = createDebugInfo();
  reportProgress(input.onProgress, {
    percent: 5,
    processed: 0,
    total: 1,
    message: 'Loading catalog database...',
    matchedTitle: null,
    debug
  });

  const entries = await loadCatalogEntries(input.catalogPath, adapters);
  if (entries === null) {
    return {
      status: 'catalog-missing',
      matchedTitle: null,
      matchScore: 0,
      titleAmbiguous: false,
      candidates: [],
      metadata: null,
      warnings,
      debug
    };
  }
  if (entries.length === 0) {
    return {
      status: 'catalog-invalid',
      matchedTitle: null,
      matchScore: 0,
      titleAmbiguous: false,
      candidates: [],
      metadata: null,
      warnings,
      debug
    };
  }

  reportProgress(input.onProgress, {
    percent: 15,
    processed: 0,
    total: 1,
    message: 'Matching game title using executable metadata...',
    matchedTitle: null,
    debug
  });

  const readExeMetadata = adapters.readExeMetadata ?? readExeMetadataFromFile;
  const metadata = await readExeMetadata(input.exePath).catch(() => null);
  debug.exeProductName = metadata?.productName ?? null;
  debug.exeFileDescription = metadata?.fileDescription ?? null;
  const installFolderName = path.basename(path.normalize(input.installPath));
  const exeFileName = path.parse(path.basename(input.exePath)).name;
  const queryNames = dedupeStrings([
    metadata?.productName ?? '',
    metadata?.fileDescription ?? '',
    input.gameName,
    installFolderName,
    exeFileName
  ]);
  debug.queryStrings = queryNames;

  const ranked = entries
    .map((entry) => ({
      entry,
      score: queryNames.reduce((best, query) => Math.max(best, scoreTitleSimilarity(query, entry.title)), 0)
    }))
    .sort((left, right) => right.score - left.score);
  debug.topTitleMatches = ranked.slice(0, 3).map((item) => ({
    title: item.entry.title,
    score: item.score
  }));

  const best = ranked[0];
  if (!best || best.score < 0.45) {
    return {
      status: 'no-match',
      matchedTitle: null,
      matchScore: best?.score ?? 0,
      titleAmbiguous: false,
      candidates: [],
      metadata,
      warnings,
      debug
    };
  }

  const second = ranked[1];
  const titleAmbiguous = Boolean(second && second.score >= 0.65 && best.score - second.score <= 0.05);
  if (titleAmbiguous && second) {
    warnings.push(`Ambiguous title match: "${best.entry.title}" vs "${second.entry.title}".`);
  }

  const windowsLocations = dedupeStrings(
    best.entry.saveLocations
      .filter((location) => location.system.trim().toLowerCase() === 'windows')
      .flatMap((location) => splitCompositeLocation(location.location.trim()))
      .filter((location) => location.length > 0)
  );
  debug.windowsLocations = windowsLocations;

  if (windowsLocations.length === 0) {
    return {
      status: 'no-windows-locations',
      matchedTitle: best.entry.title,
      matchScore: best.score,
      titleAmbiguous,
      candidates: [],
      metadata,
      warnings,
      debug
    };
  }

  const listSteamLibraries = adapters.listSteamLibraries ?? detectSteamLibraries;
  const readRegistryValues = adapters.readRegistryValues ?? readRegistryValuesFromKey;
  const steamLibraries = await listSteamLibraries().catch(() => []);
  const resolutionContext: ResolveContext = {
    installPath: input.installPath,
    gameName: input.gameName,
    steamLibraries
  };

  const resolvedCandidates: CatalogSavePathCandidate[] = [];
  const totalLocations = windowsLocations.length;

  reportProgress(input.onProgress, {
    percent: 20,
    processed: 0,
    total: totalLocations,
    message: `Matched "${best.entry.title}". Resolving Windows save locations...`,
    matchedTitle: best.entry.title,
    debug
  });

  for (let index = 0; index < windowsLocations.length; index += 1) {
    const rawLocation = windowsLocations[index];
    if (!rawLocation) {
      continue;
    }

    reportProgress(input.onProgress, {
      percent: 20 + Math.round((index / Math.max(1, totalLocations)) * 70),
      processed: index,
      total: totalLocations,
      message: `Checking location ${index + 1}/${totalLocations}...`,
      matchedTitle: best.entry.title,
      debug
    });
    debug.currentLocation = rawLocation;
    debug.expandedPaths = [];

    if (isRegistryPath(rawLocation)) {
      const registryKey = normalizeRegistryPath(rawLocation);
      const registryValues = await readRegistryValues(registryKey).catch(() => []);
      for (const registryValue of registryValues) {
        const paths = expandLocationTemplate(registryValue, resolutionContext);
        updateDebugPathSamples(debug, paths);
        for (const candidatePath of paths) {
          const candidate = scoreCandidatePath(candidatePath, 'registry', rawLocation);
          if (candidate) {
            resolvedCandidates.push(candidate);
            updateDebugSelectedCandidate(debug, candidate);
          }
        }
      }
    } else {
      const paths = expandLocationTemplate(rawLocation, resolutionContext);
      updateDebugPathSamples(debug, paths);
      for (const candidatePath of paths) {
        const candidate = scoreCandidatePath(candidatePath, 'filesystem', rawLocation);
        if (candidate) {
          resolvedCandidates.push(candidate);
          updateDebugSelectedCandidate(debug, candidate);
        }
      }
    }

    reportProgress(input.onProgress, {
      percent: 20 + Math.round(((index + 1) / Math.max(1, totalLocations)) * 70),
      processed: index + 1,
      total: totalLocations,
      message: `Validated ${index + 1}/${totalLocations} locations.`,
      matchedTitle: best.entry.title,
      debug
    });
  }

  reportProgress(input.onProgress, {
    percent: 95,
    processed: totalLocations,
    total: totalLocations,
    message: 'Ranking candidate save paths...',
    matchedTitle: best.entry.title,
    debug
  });

  const candidates = mergeCandidatesByPath(resolvedCandidates);
  const topCandidate = candidates[0];
  if (topCandidate) {
    updateDebugSelectedCandidate(debug, topCandidate);
  }
  if (candidates.length === 0) {
    return {
      status: 'no-valid-candidates',
      matchedTitle: best.entry.title,
      matchScore: best.score,
      titleAmbiguous,
      candidates: [],
      metadata,
      warnings,
      debug
    };
  }

  return {
    status: 'matched',
    matchedTitle: best.entry.title,
    matchScore: best.score,
    titleAmbiguous,
    candidates,
    metadata,
    warnings,
    debug
  };
}

export function resetCatalogSaveDetectionCacheForTests(): void {
  catalogCache.clear();
}

function reportProgress(
  callback: ((progress: CatalogSaveDetectionProgress) => void) | undefined,
  payload: CatalogSaveDetectionProgress
): void {
  if (!callback) {
    return;
  }
  callback({
    ...payload,
    percent: Math.max(0, Math.min(100, Math.round(payload.percent))),
    processed: Math.max(0, payload.processed),
    total: Math.max(1, payload.total)
  });
}

function createDebugInfo(): CatalogSaveDetectionDebugInfo {
  return {
    exeProductName: null,
    exeFileDescription: null,
    queryStrings: [],
    topTitleMatches: [],
    windowsLocations: [],
    currentLocation: null,
    expandedPaths: [],
    checkedPathSamples: [],
    selectedCandidatePath: null,
    selectedCandidateScore: null,
    selectedCandidateReasons: []
  };
}

function pushUniqueWithLimit(target: string[], value: string, limit: number): void {
  if (!value || target.includes(value)) {
    return;
  }
  if (target.length >= limit) {
    return;
  }
  target.push(value);
}

function updateDebugPathSamples(debug: CatalogSaveDetectionDebugInfo, paths: string[]): void {
  for (const rawPath of paths) {
    const normalized = path.normalize(rawPath.trim());
    if (!normalized) {
      continue;
    }

    pushUniqueWithLimit(debug.expandedPaths, normalized, MAX_DEBUG_PATH_SAMPLES);
    const existsLabel = fs.existsSync(normalized) ? 'exists' : 'missing';
    pushUniqueWithLimit(debug.checkedPathSamples, `${existsLabel}: ${normalized}`, MAX_DEBUG_PATH_SAMPLES);
  }
}

function updateDebugSelectedCandidate(
  debug: CatalogSaveDetectionDebugInfo,
  candidate: CatalogSavePathCandidate
): void {
  if (debug.selectedCandidatePath === candidate.path) {
    debug.selectedCandidateScore = Math.max(debug.selectedCandidateScore ?? 0, candidate.score);
    debug.selectedCandidateReasons = dedupeStrings([...debug.selectedCandidateReasons, ...candidate.reasons]);
    return;
  }

  if (debug.selectedCandidateScore !== null && candidate.score < debug.selectedCandidateScore) {
    return;
  }

  debug.selectedCandidatePath = candidate.path;
  debug.selectedCandidateScore = candidate.score;
  debug.selectedCandidateReasons = [...candidate.reasons];
}

async function loadCatalogEntries(
  catalogPath: string,
  adapters: CatalogDetectionAdapters
): Promise<ParsedCatalogEntry[] | null> {
  if (adapters.loadCatalogEntries) {
    return await adapters.loadCatalogEntries(catalogPath);
  }
  if (!fs.existsSync(catalogPath)) {
    return null;
  }

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(catalogPath).mtimeMs;
  } catch {
    return null;
  }

  const cacheKey = path.resolve(catalogPath);
  const cached = catalogCache.get(cacheKey);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.entries;
  }

  try {
    const raw = fs.readFileSync(catalogPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const games = getCatalogGamesArray(parsed);
    if (!games) {
      return [];
    }

    const entries = games
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as CatalogEntry)
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title.trim() : '',
        saveLocations: normalizeCatalogLocations(item.save_game_data_locations)
      }))
      .filter((entry) => entry.title.length > 0);

    catalogCache.set(cacheKey, { mtimeMs, entries });
    return entries;
  } catch {
    return [];
  }
}

function getCatalogGamesArray(input: unknown): unknown[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  return Array.isArray(record.games) ? record.games : null;
}

function normalizeCatalogLocations(input: unknown): Array<{ system: string; location: string }> {
  if (!Array.isArray(input)) {
    return [];
  }

  const expanded = input
    .filter((item) => item && typeof item === 'object')
    .map((item) => item as CatalogLocation)
    .flatMap((item) => {
      const system = typeof item.system === 'string' ? item.system.trim() : '';
      const rawLocation = typeof item.location === 'string' ? item.location.trim() : '';
      const splitLocations = splitCompositeLocation(rawLocation);
      return splitLocations.map((location) => ({ system, location }));
    })
    .filter((item) => item.system.length > 0 && item.location.length > 0);

  const seen = new Set<string>();
  const deduped: Array<{ system: string; location: string }> = [];
  for (const item of expanded) {
    const key = `${item.system.toLowerCase()}|${item.location.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function splitCompositeLocation(location: string): string[] {
  const normalized = location.replace(/\r?\n/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const starts: number[] = [];
  LOCATION_SPLIT_START_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(LOCATION_SPLIT_START_PATTERN)) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    if (index === 0) {
      starts.push(index);
      continue;
    }
    const previous = normalized[index - 1];
    if (previous && /[\s,;|]/.test(previous)) {
      starts.push(index);
    }
  }

  const uniqueStarts = Array.from(new Set(starts)).sort((left, right) => left - right);
  if (uniqueStarts.length <= 1) {
    const simpleSplit = normalized
      .split(/[;\n\r]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return simpleSplit.length > 1 ? simpleSplit : [normalized];
  }

  const segments: string[] = [];
  for (let index = 0; index < uniqueStarts.length; index += 1) {
    const start = uniqueStarts[index];
    const end = uniqueStarts[index + 1] ?? normalized.length;
    const segment = normalized
      .slice(start, end)
      .trim()
      .replace(/^[,;|]+/, '')
      .replace(/[,;|]+$/, '')
      .trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
  }

  return segments.length > 0 ? segments : [normalized];
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function scoreTitleSimilarity(left: string, right: string): number {
  const leftNorm = normalizeTitle(left);
  const rightNorm = normalizeTitle(right);
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  if (leftNorm === rightNorm) {
    return 1;
  }

  const leftTokens = leftNorm.split(' ').filter(Boolean);
  const rightTokens = rightNorm.split(' ').filter(Boolean);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  const jaccard = union > 0 ? overlap / union : 0;
  const containsBonus = leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm) ? 0.15 : 0;
  return Math.min(1, jaccard + containsBonus);
}

function normalizeTitle(value: string): string {
  const romanNormalized = value
    .toLowerCase()
    .replace(/\bxx\b/g, '20')
    .replace(/\bxix\b/g, '19')
    .replace(/\bxviii\b/g, '18')
    .replace(/\bxvii\b/g, '17')
    .replace(/\bxvi\b/g, '16')
    .replace(/\bxv\b/g, '15')
    .replace(/\bxiv\b/g, '14')
    .replace(/\bxiii\b/g, '13')
    .replace(/\bxii\b/g, '12')
    .replace(/\bxi\b/g, '11')
    .replace(/\bx\b/g, '10')
    .replace(/\bix\b/g, '9')
    .replace(/\bviii\b/g, '8')
    .replace(/\bvii\b/g, '7')
    .replace(/\bvi\b/g, '6')
    .replace(/\bv\b/g, '5')
    .replace(/\biv\b/g, '4')
    .replace(/\biii\b/g, '3')
    .replace(/\bii\b/g, '2')
    .replace(/\bi\b/g, '1');

  return romanNormalized
    .replace(/definitive edition/g, 'de')
    .replace(/game of the year/g, 'goty')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readExeMetadataFromFile(exePath: string): Promise<ExeMetadata | null> {
  if (process.platform !== 'win32' || !fs.existsSync(exePath)) {
    return null;
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$path = $env:GAMESAVER_EXE_PATH',
    'if (-not $path) { throw "Missing GAMESAVER_EXE_PATH" }',
    '$v = (Get-Item -LiteralPath $path).VersionInfo',
    '$obj = [PSCustomObject]@{ productName = $v.ProductName; fileDescription = $v.FileDescription }',
    '$obj | ConvertTo-Json -Compress'
  ].join('; ');

  return await runPowerShellMetadataScript(script, exePath);
}

async function runPowerShellMetadataScript(script: string, exePath: string): Promise<ExeMetadata | null> {
  const shells = ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'];
  for (const shell of shells) {
    try {
      const { stdout } = await execFileAsync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          windowsHide: true,
          maxBuffer: COMMAND_MAX_BUFFER,
          timeout: COMMAND_TIMEOUT_MS,
          env: {
            ...process.env,
            GAMESAVER_EXE_PATH: exePath
          }
        }
      );
      const metadata = parseExeMetadataFromOutput(stdout);
      if (metadata) {
        return metadata;
      }
    } catch {
      // Try the next shell/strategy.
    }
  }
  return null;
}

function parseExeMetadataFromOutput(stdout: string): ExeMetadata | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = lines.length > 0 ? [...lines.reverse(), stdout.trim()] : [stdout.trim()];
  for (const candidate of candidates) {
    if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as Partial<ExeMetadata & { ProductName?: unknown; FileDescription?: unknown }>;
      const productName = normalizeMetadataString(
        typeof parsed.productName === 'string' ? parsed.productName : parsed.ProductName
      );
      const fileDescription = normalizeMetadataString(
        typeof parsed.fileDescription === 'string' ? parsed.fileDescription : parsed.FileDescription
      );
      if (!productName && !fileDescription) {
        continue;
      }
      return { productName, fileDescription };
    } catch {
      // Ignore malformed line and continue.
    }
  }

  return null;
}

function normalizeMetadataString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRegistryPath(value: string): boolean {
  return /^(HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE|HKCU|HKLM)\\/i.test(value.trim());
}

function normalizeRegistryPath(value: string): string {
  const trimmed = value.trim();
  if (/^HKCU\\/i.test(trimmed)) {
    return trimmed.replace(/^HKCU/i, 'HKEY_CURRENT_USER');
  }
  if (/^HKLM\\/i.test(trimmed)) {
    return trimmed.replace(/^HKLM/i, 'HKEY_LOCAL_MACHINE');
  }
  return trimmed;
}

async function readRegistryValuesFromKey(registryKey: string): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const root = getRegistryRoot(registryKey);
  if (!root) {
    return [];
  }

  const views: Array<'32' | '64' | null> = root === 'HKEY_LOCAL_MACHINE' ? ['64', '32'] : [null];
  const values = new Set<string>();

  for (const view of views) {
    const args = ['query', registryKey];
    if (view) {
      args.push(`/reg:${view}`);
    }
    try {
      const { stdout } = await execFileAsync('reg', args, {
        windowsHide: true,
        maxBuffer: COMMAND_MAX_BUFFER,
        timeout: COMMAND_TIMEOUT_MS
      });
      parseRegistryValues(stdout).forEach((value) => values.add(value));
    } catch {
      // Ignore per-view errors.
    }
  }

  return Array.from(values);
}

function getRegistryRoot(registryKey: string): RegistryRoot | null {
  const normalized = registryKey.toUpperCase();
  if (normalized.startsWith('HKEY_CURRENT_USER\\')) {
    return 'HKEY_CURRENT_USER';
  }
  if (normalized.startsWith('HKEY_LOCAL_MACHINE\\')) {
    return 'HKEY_LOCAL_MACHINE';
  }
  return null;
}

function parseRegistryValues(stdout: string): string[] {
  const values: string[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s+([^\s].*?)\s+REG_[A-Z0-9_]+\s+(.*)$/);
    if (!match) {
      continue;
    }
    const rawValue = match[2]?.trim() ?? '';
    const sanitized = rawValue.replace(/^"(.*)"$/, '$1').trim();
    if (!looksLikePath(sanitized)) {
      continue;
    }
    values.push(sanitized);
  }
  return values;
}

function looksLikePath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes(':\\')) {
    return true;
  }
  if (/%[^%]+%/.test(value)) {
    return true;
  }
  return value.includes('\\');
}

function expandLocationTemplate(rawLocation: string, context: ResolveContext): string[] {
  const normalized = normalizeTemplateSyntax(rawLocation);
  let templates = [normalized];

  templates = replaceTokenWithMany(templates, /<path-to-game>/gi, [context.installPath]);
  templates = replaceTokenWithMany(templates, /<steamlibrary-folder>/gi, context.steamLibraries);
  templates = replaceTokenWithMany(templates, /<steam-folder>/gi, defaultSteamRoots());
  templates = replaceTokenWithMany(templates, /<the name of the software>/gi, [
    path.basename(context.installPath),
    context.gameName
  ]);
  templates = replaceTokenWithMany(templates, /<game>/gi, [context.gameName, path.basename(context.installPath)]);

  const expanded = templates
    .map((template) => expandEnvironmentVariables(template))
    .flatMap((template) => expandUserIdTemplate(template))
    .flatMap((template) => expandWildcardTemplate(template))
    .map((template) => template.trim())
    .filter((template) => template.length > 0)
    .map((template) => stripOuterQuotes(template))
    .map((template) => path.normalize(template));

  return Array.from(new Set(expanded));
}

function normalizeTemplateSyntax(value: string): string {
  return value
    .replace(/\{\{\s*p\|userprofile\s*\}\}/gi, '%USERPROFILE%')
    .replace(/\{\{\s*p\|appdata\s*\}\}/gi, '%APPDATA%')
    .replace(/\{\{\s*p\|localappdata\s*\}\}/gi, '%LOCALAPPDATA%')
    .replace(/\{\{\s*p\|programdata\s*\}\}/gi, '%PROGRAMDATA%')
    .replace(/\{\{\s*p\|programfiles\s*\}\}/gi, '%PROGRAMFILES%')
    .replace(/\{\{\s*p\|programfiles\(x86\)\s*\}\}/gi, '%PROGRAMFILES(X86)%')
    .replace(/\{\{\s*p\|documents\s*\}\}/gi, '%USERPROFILE%\\Documents')
    .replace(/\{\{\s*p\|steam\s*\}\}/gi, '<steam-folder>');
}

function replaceTokenWithMany(templates: string[], pattern: RegExp, replacements: string[]): string[] {
  const nextReplacements = dedupeStrings(replacements.filter((item) => item.trim().length > 0));
  if (nextReplacements.length === 0) {
    return templates;
  }

  const output: string[] = [];
  for (const template of templates) {
    if (!pattern.test(template)) {
      output.push(template);
      continue;
    }
    pattern.lastIndex = 0;
    for (const replacement of nextReplacements) {
      output.push(template.replace(pattern, replacement));
      pattern.lastIndex = 0;
    }
  }
  return output;
}

function expandUserIdTemplate(template: string): string[] {
  const markerPattern = /<user[-\s]?id>/i;
  if (!markerPattern.test(template)) {
    return [template];
  }

  const marker = '__GAMESAVER_UID__';
  const replaced = template.replace(markerPattern, marker);
  const markerIndex = replaced.indexOf(marker);
  if (markerIndex < 0) {
    return [template];
  }

  const before = replaced.slice(0, markerIndex);
  const after = replaced.slice(markerIndex + marker.length);
  const parent = before.replace(/[\\/]+$/, '');

  if (!parent || !fs.existsSync(parent)) {
    return [template.replace(markerPattern, '*')];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [template.replace(markerPattern, '*')];
  }

  const candidateIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.trim().length > 0)
    .slice(0, 100);

  if (candidateIds.length === 0) {
    return [template.replace(markerPattern, '*')];
  }

  return candidateIds.map((id) => `${before}${id}${after}`);
}

function expandWildcardTemplate(template: string): string[] {
  const normalized = path.normalize(template);
  if (!hasWildcardPattern(normalized)) {
    return [normalized];
  }

  const parsed = path.parse(normalized);
  const root = parsed.root;
  const relative = normalized.slice(root.length);
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return [normalized];
  }

  let bases = [root || '.'];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    const isLast = index === segments.length - 1;
    const next: string[] = [];

    if (hasWildcardPattern(segment)) {
      const matcher = wildcardToRegExp(segment);
      for (const base of bases) {
        const directoryToRead = base || '.';
        if (!fs.existsSync(directoryToRead)) {
          continue;
        }

        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(directoryToRead, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!matcher.test(entry.name)) {
            continue;
          }
          if (!isLast && !entry.isDirectory()) {
            continue;
          }
          next.push(path.join(base, entry.name));
        }
      }
    } else {
      for (const base of bases) {
        next.push(path.join(base, segment));
      }
    }

    bases = dedupeStrings(next);
    if (bases.length === 0) {
      return [normalized];
    }
  }

  return bases.map((item) => path.normalize(item));
}

function hasWildcardPattern(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

function wildcardToRegExp(value: string): RegExp {
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

function trimTrailingPathSeparators(value: string): string {
  const root = path.parse(value).root;
  let trimmed = value;
  while (trimmed.length > root.length && /[\\/]+$/.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function expandEnvironmentVariables(template: string): string {
  return template.replace(/%([^%]+)%/g, (_full, name: string) => {
    const value = resolveEnvValue(name);
    return value ?? `%${name}%`;
  });
}

function resolveEnvValue(name: string): string | null {
  const direct = process.env[name];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const lower = name.toLowerCase();
  const match = Object.entries(process.env).find(([key, value]) => key.toLowerCase() === lower && value);
  return match?.[1] ?? null;
}

function stripOuterQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function defaultSteamRoots(): string[] {
  const roots: string[] = [];
  const pf86 = resolveEnvValue('ProgramFiles(x86)');
  const pf = resolveEnvValue('ProgramFiles');
  if (pf86) {
    roots.push(path.join(pf86, 'Steam'));
  }
  if (pf) {
    roots.push(path.join(pf, 'Steam'));
  }
  return dedupeStrings(roots);
}

async function detectSteamLibraries(): Promise<string[]> {
  const roots = defaultSteamRoots();
  const libraries = new Set<string>(roots);

  for (const root of roots) {
    const filePath = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      parseSteamLibraryFolders(raw).forEach((entry) => libraries.add(path.normalize(entry)));
    } catch {
      // Ignore parse failures and keep defaults.
    }
  }

  return Array.from(libraries);
}

function parseSteamLibraryFolders(raw: string): string[] {
  const output: string[] = [];

  const directPathRegex = /"path"\s*"([^"]+)"/gi;
  for (const match of raw.matchAll(directPathRegex)) {
    const value = match[1]?.replace(/\\\\/g, '\\').trim();
    if (value) {
      output.push(value);
    }
  }

  const legacyRegex = /"\d+"\s*"([A-Za-z]:\\\\[^"]+)"/g;
  for (const match of raw.matchAll(legacyRegex)) {
    const value = match[1]?.replace(/\\\\/g, '\\').trim();
    if (value) {
      output.push(value);
    }
  }

  return dedupeStrings(output);
}

function scoreCandidatePath(
  candidatePath: string,
  source: 'filesystem' | 'registry',
  rawLocation: string
): CatalogSavePathCandidate | null {
  const normalizedPath = trimTrailingPathSeparators(path.normalize(candidatePath.trim()));
  if (!normalizedPath || normalizedPath.includes('*') || !fs.existsSync(normalizedPath)) {
    return null;
  }

  const reasons: string[] = ['path exists'];
  let score = 0.55;

  try {
    const stats = fs.statSync(normalizedPath);
    if (stats.isFile()) {
      score += 0.15;
      const ext = path.extname(normalizedPath).toLowerCase();
      if (SAVE_FILE_EXTENSIONS.has(ext)) {
        score += 0.25;
        reasons.push(`save-like extension (${ext})`);
      }
    } else if (stats.isDirectory()) {
      score += 0.1;
      const inspection = inspectDirectory(normalizedPath);
      if (inspection.nonEmpty) {
        score += 0.1;
        reasons.push('directory not empty');
      }
      if (inspection.saveLike) {
        score += 0.2;
        reasons.push('save-like files detected');
      }
    }
  } catch {
    return null;
  }

  const lower = normalizedPath.toLowerCase();
  if (lower.includes('save') || lower.includes('profile')) {
    score += 0.05;
    reasons.push('path contains save/profile marker');
  }
  if (source === 'registry') {
    score += 0.05;
    reasons.push('resolved via registry value');
  }

  return {
    path: normalizedPath,
    score: Math.min(1, score),
    source,
    rawLocation,
    reasons
  };
}

function inspectDirectory(root: string): { nonEmpty: boolean; saveLike: boolean } {
  const queue: Array<{ folder: string; depth: number }> = [{ folder: root, depth: 0 }];
  let scannedEntries = 0;
  let nonEmpty = false;
  let saveLike = false;

  while (queue.length > 0 && scannedEntries < 300 && !saveLike) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(next.folder, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.length > 0) {
      nonEmpty = true;
    }

    for (const entry of entries) {
      scannedEntries += 1;
      const entryPath = path.join(next.folder, entry.name);
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SAVE_FILE_EXTENSIONS.has(ext)) {
          saveLike = true;
          break;
        }
      } else if (entry.isDirectory() && next.depth < 2) {
        queue.push({ folder: entryPath, depth: next.depth + 1 });
      }
      if (scannedEntries >= 300) {
        break;
      }
    }
  }

  return { nonEmpty, saveLike };
}

function mergeCandidatesByPath(input: CatalogSavePathCandidate[]): CatalogSavePathCandidate[] {
  const byPath = new Map<string, CatalogSavePathCandidate>();

  for (const candidate of input) {
    const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    const existing = byPath.get(key);
    if (!existing) {
      byPath.set(key, candidate);
      continue;
    }

    if (candidate.score > existing.score) {
      byPath.set(key, {
        ...candidate,
        reasons: dedupeStrings([...existing.reasons, ...candidate.reasons])
      });
      continue;
    }

    existing.reasons = dedupeStrings([...existing.reasons, ...candidate.reasons]);
  }

  return Array.from(byPath.values()).sort((left, right) => right.score - left.score);
}
