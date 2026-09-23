export interface Rect { x: number; y: number; w: number; h: number }

export type ElementKind =
  | 'link' | 'button' | 'textbox' | 'combobox' | 'select' | 'checkbox' | 'radio' | 'slider' | 'option' | 'tab'
  | 'menuitem' | 'clickable' | 'heading' | 'text' | 'image' | 'file' | 'other';

export type NameSource = 'aria' | 'label' | 'placeholder' | 'title' | 'content' | 'alt' | 'value' | 'nearby' | 'none';

export interface ElementStates {
  disabled?: boolean; checked?: boolean; expanded?: boolean; selected?: boolean; required?: boolean;
  invalid?: boolean; focused?: boolean; readonly?: boolean;
}

export interface ElementNode {
  ref: string;
  sig: string;
  kind: ElementKind;
  role: string;
  tag: string;
  name: string;
  nameSource: NameSource;
  value?: string;
  placeholder?: string;
  inputType?: string;
  href?: string;
  /** Visible inner text (may differ from the accessible name). */
  text?: string;
  options?: { value: string; label: string; selected: boolean }[];
  states: ElementStates;
  interactive: boolean;
  visible: boolean;
  inViewport: boolean;
  occluded: boolean;
  /** Short description of what covers the element, when occluded. */
  occludedBy?: string;
  rect: Rect;
  regionId: string;
  backendNodeId: number;
  /** CDP session of the out-of-process frame that owns the node (undefined for the main frame). */
  frameSessionId?: string;
  attrs: Record<string, string>;
  /** Nearest section heading or legend, for disambiguation. */
  context?: string;
  /** Visible text right before the control ("Сортировать по:", "Цена"), when it differs from the name. */
  label?: string;
  /** UI words found in class/id ("sort", "filter", "next"): cheap semantic signals for JEV. */
  hints?: string[];
  /** Document order across frames. */
  order: number;
}

export type RegionKind =
  | 'header' | 'nav' | 'main' | 'aside' | 'footer' | 'form' | 'dialog' | 'overlay' | 'popup' | 'list' | 'section' | 'page';

export interface Region {
  id: string;
  sig: string;
  kind: RegionKind;
  label: string;
  parentId?: string;
  refs: string[];
  rect: Rect;
  /** An overlay that covers interactive elements of other regions. */
  blocking: boolean;
  /** For list regions: element refs per repeated item, in order. */
  items?: string[][];
}

export interface PageModel {
  url: string;
  title: string;
  lang: string;
  viewport: { w: number; h: number };
  scroll: { y: number; maxY: number };
  elements: Map<string, ElementNode>;
  regions: Region[];
  /** Structural fingerprint: same page layout and state gives the same signature. */
  signature: string;
  focusedRef?: string;
  capturedAt: number;
  captureMs: number;
}

export interface PageDiff {
  urlChanged: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  newRegions: string[];
  goneRegions: string[];
  focusChanged: boolean;
}
