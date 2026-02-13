import type { Settings } from '@shared/types';
import { LANGUAGE_OPTIONS, normalizeLanguageValue, useI18n } from '@renderer/i18n';
import { useSettingsPanel } from '@renderer/hooks/useSettingsPanel';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

type SettingsPanelProps = {
  settings: Settings;
  onCancel: () => void;
  onError: (message: string) => void;
  onSaved: (settings: Settings) => void;
};

export default function SettingsPanel({ settings, onCancel, onError, onSaved }: SettingsPanelProps) {
  const { t } = useI18n();
  const {
    backupFrequencyMinutes,
    setBackupFrequencyMinutes,
    retentionCount,
    setRetentionCount,
    storageRoot,
    setStorageRoot,
    dataRoot,
    setDataRoot,
    language,
    setLanguage,
    busy,
    pickStorageRoot,
    pickDataRoot,
    handleSubmit
  } = useSettingsPanel({ settings, onError, onSaved });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t('settings_title')}</CardTitle>
          <CardDescription>{t('settings_description')}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common_close')}
        </Button>
      </CardHeader>

      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="backup-frequency">{t('settings_backup_frequency')}</Label>
            <Input
              id="backup-frequency"
              type="number"
              min={1}
              value={backupFrequencyMinutes}
              onChange={(event) => setBackupFrequencyMinutes(Number(event.target.value))}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="retention-count">{t('settings_retention_count')}</Label>
            <Input
              id="retention-count"
              type="number"
              min={1}
              value={retentionCount}
              onChange={(event) => setRetentionCount(Number(event.target.value))}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="storage-root">{t('settings_storage_root')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="storage-root"
                className="sm:flex-1"
                value={storageRoot}
                onChange={(event) => setStorageRoot(event.target.value)}
                autoComplete="off"
              />
              <Button type="button" variant="outline" onClick={pickStorageRoot}>
                {t('common_browse')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings_storage_help')}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="data-root">{t('settings_data_folder')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="data-root"
                className="sm:flex-1"
                value={dataRoot}
                onChange={(event) => setDataRoot(event.target.value)}
                autoComplete="off"
              />
              <Button type="button" variant="outline" onClick={pickDataRoot}>
                {t('common_browse')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings_data_help')}</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="language">{t('settings_language')}</Label>
            <Select value={language} onValueChange={(value) => setLanguage(normalizeLanguageValue(value))}>
              <SelectTrigger id="language" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t('settings_language_help')}</p>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy ? t('settings_saving') : t('settings_save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
