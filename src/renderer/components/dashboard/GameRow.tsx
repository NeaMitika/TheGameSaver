import type { GameSummary } from '@shared/types';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { formatDate } from '@renderer/lib/format';
import GameExeIcon from './GameExeIcon';
import { middleEllipsis } from '@renderer/lib/utils';

type GameRowProps = {
	game: GameSummary;
	onOpenDetail: (gameId: string) => void;
	onBackupNow: (gameId: string) => void;
};

export default function GameRow({ game, onOpenDetail, onBackupNow }: GameRowProps) {
	return (
		<div
			role='button'
			tabIndex={0}
			aria-label={`Open details for ${game.name}`}
			onClick={() => onOpenDetail(game.id)}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					onOpenDetail(game.id);
				}
			}}
			className='cursor-pointer rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
		>
			<div className='flex flex-wrap items-center gap-3 lg:flex-nowrap'>
				<div className='flex min-w-0 flex-1 items-center gap-3'>
					<GameExeIcon icon={game.exe_icon ?? null} name={game.name} />
					<div className='flex min-w-0 flex-col items-start justify-start gap-2'>
						<div className='flex items-center'>
							<p className='max-w-56 truncate text-sm font-semibold tracking-tight'>{game.name}</p>
							<div className='shrink-0'>
								<Badge variant={getGameStatusVariant(game.status)}>{game.status.toUpperCase()}</Badge>
							</div>
						</div>
						<p className='min-w-0 flex-1 truncate text-xs text-muted-foreground'>
							{middleEllipsis(game.install_path, 20, 20)}
						</p>
					</div>
				</div>

				<div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm lg:flex-nowrap'>
					<div className='inline-flex items-center gap-1.5 whitespace-nowrap'>
						<span className='text-muted-foreground'>Backup</span>
						<span className='font-medium'>{game.last_backup_at ? formatDate(game.last_backup_at) : 'Never'}</span>
					</div>

					<div className='inline-flex items-center gap-1.5 whitespace-nowrap'>
						<span className='text-muted-foreground'>Issues</span>
						<span className='font-medium'>{game.issue_count}</span>
					</div>
				</div>

				<div className='flex items-center gap-2 lg:ml-auto'>
					<Button
						variant='outline'
						size='sm'
						onClick={(event) => {
							event.stopPropagation();
							onBackupNow(game.id);
						}}
					>
						Backup Now
					</Button>
				</div>
			</div>
		</div>
	);
}

function getGameStatusVariant(status: GameSummary['status']): 'secondary' | 'outline' | 'destructive' {
	if (status === 'protected') return 'secondary';
	if (status === 'error') return 'destructive';
	return 'outline';
}
