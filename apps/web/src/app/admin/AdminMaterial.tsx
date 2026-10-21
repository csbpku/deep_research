'use client';

/**
 * Admin-local adapters for the old compound-control API.
 *
 * Admin pages are being moved to the shared MUI theme without changing their
 * data/query contracts. Keeping this compatibility layer inside the route
 * lets the page migration stay scoped; it does not introduce a second theme.
 */

import {
  Children,
  Fragment,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useState,
  type ElementType,
  type MouseEvent,
  type MouseEventHandler,
  type CSSProperties,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import MuiButton, { type ButtonProps as MuiButtonProps } from '@mui/material/Button';
import MuiCard from '@mui/material/Card';
import MuiCardContent from '@mui/material/CardContent';
import MuiChip, { type ChipProps } from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import MuiSelect from '@mui/material/Select';
import MuiSkeleton, { type SkeletonProps } from '@mui/material/Skeleton';
import Tab from '@mui/material/Tab';
import MuiTabs from '@mui/material/Tabs';
import Box from '@mui/material/Box';
import { AppTextField } from '@/components/material/AppTextField';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'xs' | 'icon-sm';

export type ButtonProps = Omit<MuiButtonProps, 'variant' | 'size' | 'color'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
  href?: string;
};

export function Button({
  variant = 'default',
  size = 'default',
  asChild = false,
  children,
  sx,
  ...props
}: ButtonProps) {
  const muiVariant = variant === 'default' || variant === 'destructive'
    ? 'contained'
    : variant === 'outline'
      ? 'outlined'
      : 'text';
  const color = variant === 'destructive' ? 'error' : variant === 'secondary' ? 'inherit' : 'primary';
  const toneSx = variant === 'secondary'
    ? { backgroundColor: 'action.selected', color: 'text.primary', '&:hover': { backgroundColor: 'action.focus' } }
    : variant === 'link'
      ? { minHeight: 'auto', p: 0, textDecoration: 'underline', textUnderlineOffset: '3px' }
      : {};
  const densitySx = size === 'xs'
    ? { minHeight: 30, px: 1.25, py: 0.5, fontSize: '0.75rem', '@media (pointer: coarse)': { minHeight: 44 } }
    : size === 'sm'
      ? { minHeight: 36, '@media (pointer: coarse)': { minHeight: 44 } }
      : {};
  const mergedSx = [toneSx, densitySx, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])];

  if (size === 'icon-sm') {
    const { href: _href, ...iconProps } = props;
    return (
      <IconButton
        aria-label={props['aria-label']}
        className={props.className}
        color={variant === 'destructive' ? 'error' : 'inherit'}
        disabled={props.disabled}
        onClick={props.onClick as MouseEventHandler<HTMLButtonElement> | undefined}
        size="small"
        sx={[{ minWidth: 32, minHeight: 32 }, ...mergedSx]}
        title={props.title}
        type={props.type as 'button' | 'submit' | 'reset' | undefined}
        {...iconProps}
      >
        {children}
      </IconButton>
    );
  }

  if (asChild && isValidElement(children)) {
    const child = Children.only(children) as ReactElement<Record<string, unknown>>;
    const childProps = child.props;
    return (
      <MuiButton
        {...(childProps as MuiButtonProps)}
        {...props}
        component={child.type as ElementType}
        color={color}
        sx={mergedSx}
        variant={muiVariant}
      >
        {childProps.children as ReactNode}
      </MuiButton>
    );
  }

  return (
    <MuiButton {...props} color={color} sx={mergedSx} variant={muiVariant}>
      {children}
    </MuiButton>
  );
}

export { AppTextField as Input };

export function Skeleton(props: SkeletonProps) {
  return <MuiSkeleton animation="wave" {...props} />;
}

type SelectTriggerProps = {
  id?: string;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  children?: ReactNode;
};

export function Select({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  const parts = Children.toArray(children).filter(isValidElement);
  const trigger = parts.find((child) => child.type === SelectTrigger) as ReactElement<SelectTriggerProps> | undefined;
  const content = parts.find((child) => child.type === SelectContent) as ReactElement<{ children?: ReactNode }> | undefined;
  const valueSlot = trigger ? Children.toArray(trigger.props.children).find(isValidElement) as ReactElement<{ placeholder?: string }> | undefined : undefined;
  const options = flattenOptions(content?.props.children);
  const selected = options.find((item) => item.value === value);
  const placeholder = valueSlot?.props.placeholder ?? '';

  return (
    <FormControl className={trigger?.props.className} style={trigger?.props.style} size="small" variant="outlined">
      <MuiSelect
        aria-label={trigger?.props['aria-label']}
        displayEmpty
        id={trigger?.props.id}
        inputProps={{ 'aria-label': trigger?.props['aria-label'] }}
        onChange={(event) => onValueChange(String(event.target.value))}
        renderValue={(selectedValue) => {
          if (selectedValue === '') return placeholder;
          return options.find((item) => item.value === String(selectedValue))?.label ?? String(selectedValue);
        }}
        value={value}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </MenuItem>
        ))}
      </MuiSelect>
    </FormControl>
  );
}

function flattenOptions(children: ReactNode): Array<{ value: string; label: ReactNode; disabled?: boolean }> {
  const result: Array<{ value: string; label: ReactNode; disabled?: boolean }> = [];
  const visit = (nodes: ReactNode) => {
    Children.forEach(nodes, (node) => {
      if (!isValidElement(node)) return;
      if (node.type === SelectItem) {
        const props = node.props as { value: string; children?: ReactNode; disabled?: boolean };
        result.push({ value: props.value, label: props.children, disabled: props.disabled });
      } else if (node.type === Fragment) {
        visit((node.props as { children?: ReactNode }).children);
      }
    });
  };
  visit(children);
  return result;
}

export function SelectTrigger(_props: SelectTriggerProps) {
  return null;
}
export function SelectValue(_props: { placeholder?: string }) {
  return null;
}
export function SelectContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
export function SelectItem(_props: { value: string; disabled?: boolean; children: ReactNode }) {
  return null;
}

type TabsContextValue = { value: string; onValueChange: (value: string) => void };
const TabsContext = createContext<TabsContextValue | null>(null);

export function Tabs({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return <TabsContext.Provider value={{ value, onValueChange }}>{children}</TabsContext.Provider>;
}

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  const context = useContext(TabsContext);
  if (!context) return null;
  return (
    <MuiTabs
      aria-label="Admin 模块"
      className={className}
      onChange={(_event, value: string) => context.onValueChange(value)}
      allowScrollButtonsMobile
      scrollButtons="auto"
      value={context.value}
      variant="scrollable"
      sx={{ minHeight: 40, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minWidth: 'auto', px: 1.5 } }}
    >
      {children}
    </MuiTabs>
  );
}

type TabsTriggerProps = Omit<ComponentProps<typeof Tab>, 'children' | 'value' | 'label'> & {
  value: string;
  children: ReactNode;
};

export function TabsTrigger({ value, children, ...props }: TabsTriggerProps) {
  // MuiTabs injects selection, event handlers and keyboard navigation into its
  // direct children. Forward them to the actual Tab rather than swallowing them.
  return <Tab {...props} id={`admin-tab-${value}`} aria-controls={`admin-panel-${value}`} value={value} iconPosition="start" label={children} />;
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const context = useContext(TabsContext);
  if (!context || value !== context.value) return null;
  return (
    <Box id={`admin-panel-${value}`} role="tabpanel" aria-labelledby={`admin-tab-${value}`} className={className} tabIndex={0}>
      {children}
    </Box>
  );
}

export function Card({ children, className, ...props }: ComponentProps<typeof MuiCard>) {
  return <MuiCard {...props} className={className} variant="outlined">{children}</MuiCard>;
}
export function CardContent({ children, className, ...props }: ComponentProps<typeof MuiCardContent>) {
  return <MuiCardContent {...props} className={className}>{children}</MuiCardContent>;
}

export function Badge({
  children,
  variant = 'secondary',
  className,
}: Omit<ChipProps, 'label' | 'children' | 'variant' | 'color'> & {
  children: ReactNode;
  variant?: 'secondary' | 'outline' | 'destructive';
}) {
  return (
    <MuiChip
      className={className}
      color={variant === 'destructive' ? 'error' : 'default'}
      label={children}
      size="small"
      variant={variant === 'outline' ? 'outlined' : 'filled'}
      sx={variant === 'secondary' ? { backgroundColor: 'action.selected', color: 'text.secondary' } : undefined}
    />
  );
}

type DropdownContextValue = {
  anchorEl: HTMLElement | null;
  setAnchorEl: (value: HTMLElement | null) => void;
};
const DropdownContext = createContext<DropdownContextValue | null>(null);

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  return <DropdownContext.Provider value={{ anchorEl, setAnchorEl }}>{children}</DropdownContext.Provider>;
}

export function DropdownMenuTrigger({
  children,
  asChild,
}: {
  children: ReactNode;
  asChild?: boolean;
}) {
  const context = useContext(DropdownContext);
  if (!context) return null;
  const open = (event: MouseEvent<HTMLElement>) => context.setAnchorEl(event.currentTarget);
  if (asChild && isValidElement(children)) {
    const child = Children.only(children) as ReactElement<{ onClick?: MouseEventHandler<HTMLElement> }>;
    return cloneElement(child, {
      onClick: (event: MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        if (!event.defaultPrevented) open(event);
      },
    });
  }
  return <MuiButton onClick={open}>{children}</MuiButton>;
}

export function DropdownMenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'center' | 'end' }) {
  const context = useContext(DropdownContext);
  if (!context) return null;
  const horizontal = align === 'start' ? 'left' : align === 'end' ? 'right' : 'center';
  return (
    <Menu
      anchorEl={context.anchorEl}
      anchorOrigin={{ vertical: 'bottom', horizontal }}
      onClose={() => context.setAnchorEl(null)}
      open={Boolean(context.anchorEl)}
      transformOrigin={{ vertical: 'top', horizontal }}
    >
      {children}
    </Menu>
  );
}

export function DropdownMenuItem({
  children,
  onSelect,
  disabled,
  className,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const context = useContext(DropdownContext);
  return (
    <MenuItem
      className={className}
      disabled={disabled}
      onClick={() => {
        context?.setAnchorEl(null);
        onSelect?.();
      }}
    >
      {children}
    </MenuItem>
  );
}
