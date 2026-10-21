import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import { space } from '@deep-research/design-system';

export default function Loading() {
  return (
    <Box
      role="status"
      aria-label="正在加载专题、热点议题和时间线"
      aria-busy="true"
      sx={{
        width: '100%',
        maxWidth: 'var(--dr-width-shell)',
        marginInline: 'auto',
        display: 'grid',
        gap: space.lg,
      }}
    >
      <Box sx={{ display: 'grid', justifyItems: 'start', gap: space.sm }}>
        <Skeleton variant="rounded" width={88} height={18} />
        <Skeleton variant="rounded" width="min(100%, 360px)" height={32} />
        <Skeleton variant="rounded" width="min(100%, 560px)" height={36} />
      </Box>

      <Paper variant="outlined" sx={{ minWidth: 0, overflow: 'hidden' }}>
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' },
          gap: '1px',
          bgcolor: 'divider',
        }}>
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} variant="rectangular" height={44} sx={{ borderRadius: 0 }} />
          ))}
        </Box>
      </Paper>

      <Box sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
        gap: space.lg,
      }}>
        {[0, 1].map((item) => (
          <Paper key={item} variant="outlined" sx={{ display: 'grid', gap: space.md, p: space.lg }}>
            <Skeleton variant="rounded" width={112} height={20} />
            <Skeleton variant="rounded" width="100%" height={16} />
            <Skeleton variant="rounded" width="82%" height={16} />
            <Skeleton variant="rounded" width="100%" height={72} />
          </Paper>
        ))}
      </Box>
    </Box>
  );
}
