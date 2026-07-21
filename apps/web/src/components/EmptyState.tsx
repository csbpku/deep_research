import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        border: '1px dashed #cbd5e1',
        borderRadius: 8,
        padding: '32px 24px',
        background: '#fff',
        textAlign: 'center',
        color: '#475569',
      }}
    >
      <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#0f172a' }}>{title}</h2>
      {description ? <p style={{ margin: '0 0 16px' }}>{description}</p> : null}
      {action}
    </div>
  );
}