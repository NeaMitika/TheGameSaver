import type { GameDetail } from '@shared/types';
import { useGameDetailActions } from '@renderer/hooks/useGameDetailActions';
import { formatBytes, formatDate } from '@renderer/lib/format';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { cn, middleEllipsis } from '@renderer/lib/utils';
import { ArrowLeftIcon } from 'lucide-react';

type GameDetailPanelProps = {
	detail: GameDetail;
	isRunning: boolean;
	onBack: () => void;
	onRefresh: () => void | Promise<void>;
	onRemove: () => void;
	onError: (message: string) => void;
	onSuccess: (message: string) => void;
};

export default function GameDetailPanel({
	detail,
	isRunning,
	onBack,
	onRefresh,
	onRemove,
	onError,
	onSuccess,
}: GameDetailPanelProps) {
	const {
		busySnapshot,
		handleLaunch,
		handleBackup,
		handleAddLocation,
		handleToggle,
		handleRemoveLocation,
		handleRestore,
		handleDeleteSnapshot,
		handleVerify,
		handleRemove,
	} = useGameDetailActions({
		detail,
		onRefresh,
		onRemove,
		onError,
		onSuccess,
	});

	return (
		<div className='space-y-4'>
			<div className='w-full flex items-center justify-between'>
				<h2 className='text-lg font-bold'>Game Details</h2>
				<Button variant='ghost' onClick={onBack}>
					<ArrowLeftIcon className=' h-4 w-4' />
					Back
				</Button>
			</div>
			<Card>
				<CardHeader className='gap-3'>
					<div className='flex flex-col gap-3 md:flex-row md:items-start md:justify-between'>
						<div className='space-y-2'>
							<div className='flex items-center gap-2'>
								<CardTitle>{detail.game.name}</CardTitle>
								<Badge variant={isRunning ? 'secondary' : 'outline'}>{isRunning ? 'Running' : 'Idle'}</Badge>
							</div>

							<CardDescription className='break-all line-clamp-1'>
								{middleEllipsis(detail.game.install_path, 30, 30)}
							</CardDescription>
						</div>
						<div className='flex flex-wrap gap-2'>
							<Button variant='outline' onClick={handleLaunch} disabled={isRunning}>
								Launch Game
							</Button>
							<Button variant='secondary' onClick={handleBackup}>
								Backup Now
							</Button>
						</div>
					</div>
				</CardHeader>
			</Card>

			<Card>
				<CardHeader className='flex flex-row items-center justify-between gap-4 space-y-0'>
					<div>
						<CardTitle>Save Locations</CardTitle>
						<CardDescription>Sources monitored and included in backups.</CardDescription>
					</div>
					<Button variant='outline' size='sm' onClick={handleAddLocation}>
						Add Location
					</Button>
				</CardHeader>
				<CardContent className='space-y-2'>
					{detail.saveLocations.map((location) => {
						return (
							<div
								key={location.id}
								className={cn(
									'flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between',
									!location.exists && 'border-destructive/40',
								)}
							>
								<div className='space-y-1'>
									<p className='text-sm font-medium break-all'>{location.path}</p>
									<p className='text-xs text-muted-foreground'>
										{`${location.type.toUpperCase()} · ${location.auto_detected ? 'Auto-detected' : 'Manual'}`}
									</p>
								</div>
								<div className='flex flex-wrap items-center gap-2'>
									{!location.exists && <Badge variant='destructive'>Missing</Badge>}
									<Button variant='ghost' size='sm' onClick={() => handleToggle(location)}>
										{location.enabled ? 'Disable' : 'Enable'}
									</Button>
									<Button variant='ghost' size='sm' onClick={() => handleRemoveLocation(location)}>
										Remove
									</Button>
								</div>
							</div>
						);
					})}
					{detail.saveLocations.length === 0 && (
						<div className='rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground'>
							No save locations configured.
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader className='flex flex-row items-center justify-between gap-4 space-y-0'>
					<div>
						<CardTitle>Snapshots</CardTitle>
						<CardDescription>{detail.snapshots.length} total</CardDescription>
					</div>
				</CardHeader>
				<CardContent className='space-y-2'>
					{detail.snapshots.map((snapshot) => (
						<div
							key={snapshot.id}
							className='flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between'
						>
							<div className='space-y-1'>
								<p className='text-sm font-medium'>{formatDate(snapshot.created_at)}</p>
								<p className='text-xs text-muted-foreground'>
									{snapshot.reason.toUpperCase()} · {formatBytes(snapshot.size_bytes)}
								</p>
							</div>
							<div className='flex flex-wrap gap-2'>
								<Button
									variant='ghost'
									size='sm'
									disabled={busySnapshot === snapshot.id}
									onClick={() => handleVerify(snapshot)}
								>
									Verify
								</Button>
								<Button
									variant='secondary'
									size='sm'
									disabled={busySnapshot === snapshot.id}
									onClick={() => handleRestore(snapshot)}
								>
									Restore
								</Button>
								<Button
									variant='ghost'
									size='sm'
									disabled={busySnapshot === snapshot.id}
									onClick={() => handleDeleteSnapshot(snapshot)}
								>
									Delete
								</Button>
							</div>
						</div>
					))}
					{detail.snapshots.length === 0 && (
						<div className='rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground'>
							No snapshots yet.
						</div>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Recent Activity</CardTitle>
				</CardHeader>
				<CardContent className='space-y-3'>
					<div className='overflow-hidden rounded-lg border border-slate-800 bg-slate-950 text-slate-100 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.08)]'>
						<div className='flex items-center justify-between border-b border-slate-800/90 bg-slate-900/80 px-3 py-2 font-mono text-[11px] tracking-wide text-slate-400'>
							<span>activity.log</span>
							<span className='text-slate-500'>{detail.eventLogs.length} entries</span>
						</div>
						<div className='max-h-72 space-y-1 overflow-y-auto p-2 font-mono text-[12px] leading-relaxed'>
							{detail.eventLogs.map((log, index) => {
								const style = getEventLogStyle(log.type);
								return (
									<div
										key={log.id}
										className={cn(
											'grid grid-cols-[auto_auto_1fr] items-start gap-2 rounded border px-2 py-1.5',
											style.row,
										)}
									>
										<span className={cn('pt-px text-[11px]', style.symbol)}>{'>'}</span>
										<span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider', style.chip)}>
											{style.label}
										</span>
										<div className='min-w-0'>
											<p className={cn('wrap-break-word text-[12px]', style.message)}>{log.message}</p>
											<p className='mt-0.5 text-[10px] text-slate-500'>
												#{String(detail.eventLogs.length - index).padStart(3, '0')} · {formatDate(log.created_at)}
											</p>
										</div>
									</div>
								);
							})}
							{detail.eventLogs.length === 0 && (
								<div className='rounded border border-dashed border-slate-800 px-3 py-6 text-center text-[11px] text-slate-500'>
									No recent events.
								</div>
							)}
						</div>
					</div>
				</CardContent>
			</Card>

			<Card className='border-destructive/40'>
				<CardHeader>
					<CardTitle>Danger Zone</CardTitle>
					<CardDescription>Remove this game and delete its backups from disk.</CardDescription>
				</CardHeader>
				<CardContent>
					<Button variant='destructive' onClick={handleRemove}>
						Remove Game
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}

type EventLogStyle = {
	label: string;
	row: string;
	chip: string;
	symbol: string;
	message: string;
};

function getEventLogStyle(type: 'backup' | 'restore' | 'error'): EventLogStyle {
	if (type === 'error') {
		return {
			label: 'ERR',
			row: 'border-rose-500/25 bg-rose-500/8',
			chip: 'border border-rose-500/40 bg-rose-500/20 text-rose-200',
			symbol: 'text-rose-400',
			message: 'text-rose-100',
		};
	}
	if (type === 'restore') {
		return {
			label: 'RST',
			row: 'border-cyan-500/25 bg-cyan-500/8',
			chip: 'border border-cyan-500/40 bg-cyan-500/20 text-cyan-200',
			symbol: 'text-cyan-400',
			message: 'text-cyan-100',
		};
	}
	return {
		label: 'BKP',
		row: 'border-emerald-500/25 bg-emerald-500/8',
		chip: 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-200',
		symbol: 'text-emerald-400',
		message: 'text-emerald-100',
	};
}
