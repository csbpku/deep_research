import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindDialogFocus } from './dialog-focus';

type FocusTarget = {
  isConnected: boolean;
  getClientRects: () => object[];
  focus: () => void;
};

function createElement(): FocusTarget {
  const element: FocusTarget = {
    isConnected: true,
    getClientRects: () => [{}],
    focus: () => { if (element.isConnected) activeElement = element; },
  };
  return element;
}

let activeElement: FocusTarget | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  activeElement = null;
});

describe('bindDialogFocus', () => {
  it('focuses the chosen action, traps Tab, closes on Escape, and restores focus', () => {
    const previousFocus = createElement();
    const close = createElement();
    const install = createElement();
    const open = createElement();
    const focusable = [close, install, open];
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    activeElement = previousFocus;
    vi.stubGlobal('document', {
      get activeElement() { return activeElement; },
      addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    const dialog = {
      querySelector: () => install,
      querySelectorAll: () => focusable,
      contains: (element: unknown) => focusable.includes(element as typeof close),
      focus: vi.fn(),
    };
    const onClose = vi.fn();
    const cleanup = bindDialogFocus(dialog as unknown as HTMLElement, onClose);
    const keydown = listeners.get('keydown');
    if (!keydown) throw new Error('dialog keyboard listener was not registered');
    const press = (key: string, shiftKey = false) => {
      const event = { key, shiftKey, preventDefault: vi.fn() } as unknown as KeyboardEvent;
      keydown(event);
      return event;
    };

    expect(activeElement).toBe(install);
    open.focus();
    const wrapForward = press('Tab');
    expect(wrapForward.preventDefault).toHaveBeenCalledOnce();
    expect(activeElement).toBe(close);
    const wrapBackward = press('Tab', true);
    expect(wrapBackward.preventDefault).toHaveBeenCalledOnce();
    expect(activeElement).toBe(open);

    press('Escape');
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    expect(listeners.has('keydown')).toBe(false);
    expect(activeElement).toBe(previousFocus);
  });
});
