/** Key definitions for CDP Input.dispatchKeyEvent. */
export interface KeyDef { key: string; code: string; keyCode: number; text?: string }

const KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

export const KEY_NAMES = Object.keys(KEYS);

export function keyDef(name: string): KeyDef {
  const normalized = name.length === 1 ? name : name[0].toUpperCase() + name.slice(1);
  const def = KEYS[normalized] ?? KEYS[name];
  if (def) return def;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    return { key: name, code: isLetter ? `Key${upper}` : '', keyCode: isLetter ? upper.charCodeAt(0) : 0, text: name };
  }
  throw new Error(`Unknown key "${name}". Known keys: ${KEY_NAMES.join(', ')} or a single character.`);
}

export const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
