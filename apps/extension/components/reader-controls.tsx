import React, { useLayoutEffect, useRef, useState } from 'react';
import Button, { type ButtonProps } from '@mui/material/Button';
import TextField, { type TextFieldProps } from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import NativeSelect from '@mui/material/NativeSelect';
import OutlinedInput from '@mui/material/OutlinedInput';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Typography from '@mui/material/Typography';
import { ComposerIcon } from './reader-header';

export type ReaderControl = 'default' | 'tonal' | 'navigation' | 'mode' | 'scope' | 'icon' | 'compact' | 'provider' | 'followup' | 'model';
export function ReaderButton({ control = 'default', ...props }: ButtonProps & { control?: ReaderControl }) {
  return <Button variant="text" {...props} data-reader-control={control} disableElevation disableRipple size="small" />;
}
export function ReaderTextField({ className, slotProps, ...props }: TextFieldProps) {
  const initiallyHidden = className?.split(/\s/u).includes('hidden');
  const nativeProps = typeof slotProps?.htmlInput === 'object' ? slotProps.htmlInput : {};
  return <TextField variant="outlined" size="small" fullWidth {...props} className={className?.replace(/\bhidden\b/gu, '').trim()} slotProps={{ ...slotProps, htmlInput: { ...nativeProps, ...(initiallyHidden ? { className: 'hidden' } : {}) } }} />;
}
export function ReaderSelect({ id, className, children, defaultValue }: { id: string; className?: string; children: React.ReactNode; defaultValue?: string }) {
  return <FormControl fullWidth size="small" className={className}>
    <NativeSelect input={<OutlinedInput />} inputProps={{ id }} defaultValue={defaultValue}>{children}</NativeSelect>
  </FormControl>;
}
/** The controller can expand a disclosure without owning its component state. */
export function ReaderDisclosure({ id, className, label, children }: { id?: string; className?: string; label: React.ReactNode; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    Object.defineProperty(node, 'open', { configurable: true, get: () => expanded, set: value => setExpanded(Boolean(value)) });
    node.toggleAttribute('open', expanded);
    // The reading controller owns the visibility of some regions and records
    // it in `data-reader-visible`. Expanding an MUI Accordion re-renders
    // this component, which rewrites the whole class attribute and would
    // silently restore the initial `hidden` class. Re-apply the recorded
    // decision after every render so an expanded region stays readable.
    const visible = node.dataset.readerVisible;
    if (visible) node.classList.toggle('hidden', visible === 'false');
    return () => { delete (node as HTMLDivElement & { open?: boolean }).open; };
  });
  return <Accordion ref={ref} id={id} className={className} expanded={expanded} onChange={(_, value) => setExpanded(value)} disableGutters elevation={0}>
    <AccordionSummary expandIcon={<ComposerIcon kind="chevron-down" size={20} />}><Typography component="span" variant="subtitle2">{label}</Typography></AccordionSummary>
    <AccordionDetails>{children}</AccordionDetails>
  </Accordion>;
}
