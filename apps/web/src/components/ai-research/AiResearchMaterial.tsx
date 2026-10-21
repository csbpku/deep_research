'use client';

import React, { Children, forwardRef, type ElementType, type ReactElement, type TextareaHTMLAttributes } from 'react';
import Button, { type ButtonProps } from '@mui/material/Button';
import OutlinedInput, { type OutlinedInputProps } from '@mui/material/OutlinedInput';
import type { SxProps, Theme } from '@mui/material/styles';

type ActionVariant = 'default' | 'outline' | 'ghost' | 'link' | 'secondary' | 'destructive';
type ActionSize = 'xs' | 'sm' | 'default' | 'lg' | 'icon-sm';

type AiResearchButtonProps = Omit<ButtonProps, 'size' | 'variant'> & {
  asChild?: boolean;
  size?: ActionSize;
  variant?: ActionVariant;
};

/** Feature-local MUI action adapter for the former button call sites. */
export function AiResearchButton({
  asChild = false,
  children,
  className,
  size = 'sm',
  sx,
  variant = 'default',
  ...props
}: AiResearchButtonProps) {
  const child = asChild ? Children.only(children) as ReactElement<Record<string, unknown>> : null;
  const childProps = child?.props ?? {};
  const visualVariant = variant === 'default' || variant === 'destructive'
    ? 'contained'
    : variant === 'outline'
      ? 'outlined'
      : 'text';
  const customStyles: SxProps<Theme> = [
    ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
    ...(variant === 'secondary' ? [{ bgcolor: 'action.selected', color: 'primary.main', '&:hover': { bgcolor: 'primary.light' } }] : []),
    ...(variant === 'link' ? [{ minHeight: 'auto', minWidth: 0, px: 0, textDecoration: 'underline', textUnderlineOffset: '2px', '&:hover': { bgcolor: 'transparent' } }] : []),
    ...(variant === 'destructive' ? [{ bgcolor: 'error.main', color: 'error.contrastText', '&:hover': { bgcolor: 'error.dark' } }] : []),
    ...(size === 'icon-sm' ? [{ width: 36, minWidth: 36, height: 36, p: 0 }] : []),
    { '&[aria-pressed="true"]': { bgcolor: 'action.selected', color: 'primary.main', borderColor: 'primary.main' } },
  ];

  const muiProps = {
    ...childProps,
    ...props,
    ...(asChild && child ? { component: child.type as ElementType } : {}),
    className: [childProps.className, className].filter((value): value is string => typeof value === 'string').join(' ') || undefined,
    size: size === 'lg' ? 'large' as const : 'small' as const,
    variant: visualVariant,
    color: variant === 'destructive' ? 'error' as const : 'primary' as const,
    sx: customStyles,
  };

  return <Button {...muiProps as ButtonProps}>{asChild && child ? childProps.children as React.ReactNode : children}</Button>;
}

export type AiResearchTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'onKeyDown'> & {
  onChange?: TextareaHTMLAttributes<HTMLTextAreaElement>['onChange'];
  onKeyDown?: TextareaHTMLAttributes<HTMLTextAreaElement>['onKeyDown'];
  sx?: SxProps<Theme>;
};

export const AiResearchTextarea = forwardRef<HTMLTextAreaElement, AiResearchTextareaProps>(
  function AiResearchTextarea({
    autoComplete,
    autoFocus,
    className,
    defaultValue,
    disabled,
    id,
    maxLength,
    name,
    onChange,
    onKeyDown,
    placeholder,
    readOnly,
    required,
    rows = 3,
    style,
    sx,
    value,
    ...inputProps
  }, ref) {
    const fieldSx: SxProps<Theme> = [
      ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      { alignItems: 'flex-start' },
    ];
    // Match AppTextField's MUI 9 native-input contract. MUI types the slot as an
    // input even though multiline renders a textarea, so preserve native attrs
    // with the same narrow adapter cast used by the shared field.
    const nativeInputProps = { ...inputProps, maxLength } as unknown as OutlinedInputProps['inputProps'];
    return (
      <OutlinedInput
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className={className}
        defaultValue={defaultValue}
        disabled={disabled}
        fullWidth
        id={id}
        inputRef={ref}
        name={name}
        multiline
        onChange={onChange as OutlinedInputProps['onChange']}
        onKeyDown={onKeyDown as OutlinedInputProps['onKeyDown']}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        rows={rows}
        inputProps={nativeInputProps}
        style={style}
        sx={fieldSx}
        value={value}
      />
    );
  },
);
