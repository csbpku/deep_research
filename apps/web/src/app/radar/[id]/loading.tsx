import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';

export default function Loading() {
  return (
    <Box sx={{ display: 'flex', minHeight: 0, flex: 1, flexDirection: 'column', overflowY: 'auto', bgcolor: 'background.default' }} role="status" aria-label="正在加载雷达详情">
      <Box component="header" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 56, px: { xs: 2, sm: 3 }, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', gap: 1.5 }}><Skeleton variant="text" width={96} /><Skeleton variant="text" width={64} /></Box>
        <Box sx={{ display: 'flex', gap: 1 }}><Skeleton variant="rounded" width={64} height={36} /><Skeleton variant="rounded" width={96} height={36} /></Box>
      </Box>
      <Box sx={{ mx: 'auto', width: '100%', maxWidth: 1280, px: { xs: 2, sm: 3, md: 4 }, py: { xs: 4, sm: 5 } }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 304px' }, gap: { xs: 3, lg: 5 } }}>
          <Box>
            <Box sx={{ display: 'flex', gap: 1.5 }}><Skeleton variant="text" width={96} /><Skeleton variant="text" width={80} /><Skeleton variant="text" width={64} /></Box>
            <Skeleton variant="text" sx={{ mt: 2, height: 40, maxWidth: 720 }} />
            <Skeleton variant="rounded" sx={{ mt: 3, height: 128, maxWidth: 720 }} />
            <Box sx={{ display: 'flex', gap: 1, mt: 2.5 }}><Skeleton variant="rounded" width={80} height={24} /><Skeleton variant="rounded" width={112} height={24} /><Skeleton variant="rounded" width={72} height={24} /></Box>
          </Box>
          <Box sx={{ borderBlock: { xs: 1, lg: 0 }, borderLeft: { lg: 1 }, borderColor: 'divider', py: 2, pl: { lg: 3 } }}>
            <Skeleton variant="text" width={80} />
            <Skeleton variant="text" width={144} sx={{ mt: 1 }} />
            <Skeleton variant="rounded" width={80} height={32} sx={{ mt: 3 }} />
            <Skeleton variant="text" width="100%" sx={{ mt: 2 }} />
          </Box>
        </Box>
        <Box sx={{ mt: 6, borderTop: 1, borderColor: 'divider', pt: 3 }}>
          <Skeleton variant="text" width={80} />
          <Skeleton variant="text" width={288} sx={{ mt: 1 }} />
          <Skeleton variant="rounded" width="100%" height={64} sx={{ mt: 2, maxWidth: 720 }} />
        </Box>
      </Box>
    </Box>
  );
}
