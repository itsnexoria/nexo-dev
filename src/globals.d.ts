// Ambient types for the shared renderer scope. Only features/git-extra.ts is still @ts-nocheck (it reassigns functions on purpose). tsconfig uses strict with strictNullChecks off
// legacy; remove the pragma from a file and fix errors to migrate it.
declare const monaco: any;
declare const marked: any;
declare const DOMPurify: any;
declare function require(deps: string[] | string, cb?: (...a: any[]) => void): any;
declare namespace require { function config(c: any): void }
interface Window { nexo: NexoApi; }
interface Window { nexoA11y?: any; }
interface Window { NexoKeys: any; nexoKeybindings: any; nexoExtensions: any; nexoWorkspace: any; removeWorkspaceRoot: any; monaco: any; __ptyReady: any; FitAddon: any; Terminal: any; }
declare const Terminal: any;
declare const FitAddon: any;
declare const module: any;
declare function sleep(ms: number): Promise<void>;
interface Window { marked: any; DOMPurify: any; nexoTour: any; [k: string]: any; }
// Pragmatic DOM leniency for legacy code that reads form props off getElementById() results.
interface HTMLElement { placeholder: any; select: any; value: any; checked: any; disabled: any; src: any; naturalWidth: number; naturalHeight: number; }
interface EventTarget { classList: any; closest: any; value: any; }
interface Element { dataset: any; }
interface EventTarget { id: any; href: any; }
interface File { path: any; }
interface Element { style: any; focus: any; selectionStart: any; selectionEnd: any; }
interface Event { key: any; shiftKey: any; ctrlKey: any; metaKey: any; altKey: any; }
