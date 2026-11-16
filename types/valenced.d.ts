// Ambient declarations for the official Valenced plugin API.
// Plugins use `export default plugin({...})` plus `@valenced/*` imports, which
// build.mjs rewrites to `valenced.*` lookups at bundle time. These declarations
// exist so `tsc --noEmit` passes without the device-only runtime.
declare function plugin<T = any>(config: {
    jsonStorage?: { load?: boolean; default?: any; file?: string };
    start?(api: any): any;
    stop?(api: any): any;
    SettingsComponent?(props: { api: any }): any;
    [key: string]: any;
}): any;

declare module 'react' {
    export const useState: any;
    export const useEffect: any;
    export const useMemo: any;
    export const useCallback: any;
    export const useRef: any;
    export const Fragment: any;
    export const cloneElement: any;
    export const isValidElement: any;
    export const createElement: any;
    const React: any;
    export default React;
}

declare module 'react/jsx-runtime' {
    export function jsx(...args: any[]): any;
    export function jsxs(...args: any[]): any;
    export const Fragment: any;
}

declare module 'react-native' {
    export const Modal: any;
    export const AppState: any;
    export const Appearance: any;
    export const View: any;
    export const Text: any;
    export const Image: any;
    export const TextInput: any;
    export const Pressable: any;
    export const ScrollView: any;
    export const Switch: any;
    export const Alert: any;
    const RN: any;
    export default RN;
}

declare module '@valenced/discord/common/import-tracker' {
    // path -> Metro module id, recorded as the client imports each file. This is
    // how a plugin finds where a module really lives on this build.
    export const mImportedPaths: Map<string, number>;
    export const sImportedPath: Set<(id: number, path: string) => void>;
}

declare module '@valenced/discord/flux' {
    export function onFluxEventDispatched(type: string, listener: (payload: any) => any): () => void;
    export function onAnyFluxEventDispatched(listener: (payload: any) => any): () => void;
    export const Stores: any;
    export function getStore(name: string, callback: (store: any) => void): () => void;
}

declare module '@valenced/discord/common/flux' {
    export const Dispatcher: any;
}

declare module '@valenced/discord/design' {
    export const Design: any;
}

declare module '@valenced/discord/actions' {
    export const ToastActionCreators: any;
    export const AlertActionCreators: any;
    export const ActionSheetActionCreators: any;
}

declare module '@valenced/discord/native' {
    export const FileModule: any;
    export const BundleUpdaterManager: any;
    export const ClientInfoModule: any;
}

declare module '@valenced/modules/metro/subscriptions' {
    export * from '@valenced/discord/utils/modules/metro/subscriptions';
}

declare module '@valenced/discord/utils/modules/metro/subscriptions' {
    export function onModuleInitialized(id: number, callback: (...args: any[]) => any): () => void;
    export function onAnyModuleInitialized(callback: (...args: any[]) => any): () => void;
    export function onModuleFirstRequired(id: number, callback: (...args: any[]) => any): () => void;
    export function onAnyModuleFirstRequired(callback: (...args: any[]) => any): () => void;
}

declare module '@valenced/patcher' {
    export function before(parent: any, key: string, hook: (args: any[], self: any) => any): () => void;
    export function after(parent: any, key: string, hook: (args: any[], ret: any, self: any) => any): () => void;
    export function instead(parent: any, key: string, hook: (args: any[], original: any, self: any) => any): () => void;
}

declare module '@valenced/modules/finders' {
    export function lookupModule(filter: any, options?: any): [any, number | undefined];
    export function lookupModules(filter: any, options?: any): Generator<[any, number]>;
    export function getModules(filter: any, callback: (exports: any, id: number) => void, options?: any): () => void;
    export function waitForModules(filter: any, callback: (exports: any, id: number) => void, options?: any): () => void;
}

declare module '@valenced/modules/finders/filters' {
    export function withProps(...props: string[]): any;
    export function withName(name: string): any;
    export function allOf(...filters: any[]): any;
    export function anyOf(...filters: any[]): any;
    // Builds a filter from a test over a module's exports, for the cases the
    // ready-made filters cannot express (matching a component's displayName).
    export function createFilterGenerator(test: (args: any[], scopes: any, exports: any) => boolean, label?: (args: any[]) => string): (...args: any[]) => any;
}

declare module '@valenced/json-storage' {
    export function getJsonStorage<T>(path: string, options?: any): any;
}

declare module '@valenced/react/jsx-runtime' {
    export function beforeJSX(type: any, hook: (args: any[]) => any[]): () => void;
    export function afterJSX(type: any, hook: (element: any) => any): () => void;
    export function insteadJSX(type: any, hook: (args: any[], original: any) => any): () => void;
}

declare module '@valenced/react' {
    export const React: any;
    export const ReactNative: any;
}

declare module '@valenced/utils' {
    const utils: any;
    export default utils;
}

declare module '@valenced/utils/discord' {
    export function lookupGeneratedIconComponent(name: string): any;
}

declare module '@valenced/discord/utils/modules/finders' {
    export function getModuleWithImportedPath<T>(path: string, callback: (exports: T, id?: any) => void): () => void;
    export function getModule<T>(path: string, callback: (exports: T, id?: any) => void): () => void;
    export function lookupModuleWithImportedPath<T>(path: string): [T | undefined, any];
    export function lookupModulesWithImportedPath<T>(path: string): Generator<[T, any]>;
}

declare module '@valenced/discord/modules/settings' {
    export function onSettingsModulesLoaded(callback: () => void): () => void;
    export function registerSettingsSection(key: string, config: { label: string; settings: string[] }): () => void;
    export function registerSettingsItem(key: string, config: any): () => void;
}

declare module '@valenced/discord/common/tokens' {
    export const Tokens: any;
}

declare module '@valenced/discord/common' {
    export const Tokens: any;
    export const Logger: any;
    export const Constants: any;
}
