'use client';

import React, { forwardRef, type ComponentProps } from 'react';
import OutlinedInput, { type OutlinedInputProps } from '@mui/material/OutlinedInput';

/** Native input attributes/events/ref: editor textareas intentionally do not use this. */
export const AppTextField = forwardRef<HTMLInputElement, Omit<ComponentProps<'input'>, 'onSubmit'> & Pick<OutlinedInputProps, 'sx'>>(
  function AppTextField({ className, style, sx, disabled, value, defaultValue, onChange, type, id, name, ...inputProps }, ref) {
    // MUI's input slot is typed as input | textarea; this wrapper is input-only,
    // but native input event handlers are narrower than that union.
    const nativeInputProps = inputProps as unknown as OutlinedInputProps['inputProps'];
    return (
      <OutlinedInput
        fullWidth
        id={id}
        name={name}
        type={type}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onChange={onChange}
        inputRef={ref}
        className={className}
        style={style}
        sx={sx}
        inputProps={nativeInputProps}
      />
    );
  },
);
