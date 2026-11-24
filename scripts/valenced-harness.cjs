// Shared harness for the per-plugin verifiers. Boots a built bundle the way
// Valenced does: `plugin` is the identity wrapper, `valenced` is the sandbox,
// and `@valenced/*` imports arrive as `valenced.*` lookups (see build.mjs).
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

// This repository builds each plugin in place, at plugins/<folder>/build/js.
// The manifest's id is what the catalog keys on, so the folder is found by id.
function pluginFolder(id) {
    const root = join(__dirname, '..', 'plugins');
    for (const name of readdirSync(root)) {
        try {
            const manifest = JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8'));
            if (manifest.id === id) return join(root, name);
        } catch {}
    }
    throw new Error(id + ': no plugin folder has that manifest id');
}

function createElement(type, props, ...children) {
    let kids = children.length ? children : props?.children;
    if (typeof type === 'function') {
        try {
            return type({ ...(props || {}), children: kids });
        } catch {
            return { type: type.name || 'Component', props, children: kids };
        }
    }
    return { type, props, children: kids };
}

const React = {
    Fragment: 'Fragment',
    createElement,
    // Mirror of React.cloneElement: merged props win, children replace.
    cloneElement: (element, props) =>
        createElement(element?.type, { ...(element?.props ?? {}), ...(props ?? {}) }),
    isValidElement: (value) => !!(value && typeof value === 'object' && 'type' in value && 'props' in value),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
};

function makeJsx() {
    // The automatic runtime carries children inside props.children; a third
    // argument is the element key, never a child. Passing it through made every
    // keyed element (rows built with `map`) render its key string as its only
    // child, so verifiers could not see those rows at all.
    const build = (type, props) => createElement(type, props);
    const calls = [];
    return {
        jsx: build,
        jsxs: build,
        Fragment: 'Fragment',
        calls,
        beforeJSX: () => () => {},
        afterJSX: (type, hook) => {
            calls.push({ type, hook });
            return () => {};
        },
        insteadJSX: () => () => {},
    };
}

const NATIVE_TYPES = new Set([
    'TableRowGroup',
    'TableSwitchRow',
    'TableRow',
    'TableRadioGroup',
    'TableRadioRow',
    'DTextInput',
    'DTextField',
    'DButton',
]);

// Discord's design components, detected by name. The real client renders them
// natively; here they are markers so verifiers can tell the native path apart.
const DESIGN_STUB = {
    TableRowGroup: 'TableRowGroup',
    TableSwitchRow: 'TableSwitchRow',
    TableRow: 'TableRow',
    TableRadioGroup: 'TableRadioGroup',
    TableRadioRow: 'TableRadioRow',
    Stack: 'DStack',
    TextInput: 'DTextInput',
    TextField: 'DTextField',
    Text: 'DText',
    Button: 'DButton',
    AlertModal: 'AlertModal',
    AlertActionButton: 'AlertActionButton',
};

// A real React Native component is an object/function, never a string. A
// bundle that writes { type: 'Pressable' } renders fine against string stubs
// and then throws "View config not found for name Pressable" on a device, so
// `strictNative` hands out component functions to catch exactly that.
function nativeComponent(name) {
    const Component = function (props) {
        return { type: Component, props: props ?? {}, children: props?.children };
    };
    Component.displayName = name;
    return Component;
}

function createSandbox({ stores = {}, fluxStores = {}, restModules = [], design = true, strictNative = false } = {}) {
    const cleanups = [];
    const toasts = [];
    const alerts = [];
    // Action sheets closed through ActionSheetActionCreators, in order.
    const actionSheets = [];
    // Alert dialogs opened through AlertActionCreators, in order.
    const modalAlerts = [];
    const fluxHandlers = new Map();
    const registered = [...restModules];

    // A system alert keeps its buttons, so a verifier can press one.
    const alert = (title, body, buttons, options) =>
        alerts.push({
            title: String(title),
            body: String(body),
            buttons: Array.isArray(buttons) ? buttons : [],
            options,
        });

    const RN = strictNative
        ? {
              View: nativeComponent('View'),
              Text: nativeComponent('Text'),
              Image: nativeComponent('Image'),
              TextInput: nativeComponent('TextInput'),
              Pressable: nativeComponent('Pressable'),
              ScrollView: nativeComponent('ScrollView'),
              Switch: nativeComponent('Switch'),
              Alert: { alert },
          }
        : {
              View: 'View',
              Text: 'Text',
              Image: 'Image',
              TextInput: 'TextInput',
              Pressable: 'Pressable',
              ScrollView: 'ScrollView',
              Switch: 'Switch',
              Alert: { alert },
          };

    const flux = {
        handlers: fluxHandlers,
        onFluxEventDispatched(event, handler) {
            fluxHandlers.set(event, handler);
            return () => fluxHandlers.delete(event);
        },
        onAnyFluxEventDispatched() {
            return () => {};
        },
        getStore(name, callback) {
            const found = flux.Stores[name];
            if (found) {
                try {
                    callback(found);
                } catch {}
            }
            return () => {};
        },
        Stores: { ...stores, ...fluxStores },
    };

    const finders = {
        withProps: (...props) => ({ __kind: 'props', props }),
        withName: (name) => ({ __kind: 'name', name }),
        allOf: (...filters) => ({ __kind: 'all', filters }),
        anyOf: (...filters) => ({ __kind: 'any', filters }),
        // A filter written by the plugin itself, as
        // createFilterGenerator documents: the test gets the parsed arguments,
        // the scopes and the module's exports.
        createFilterGenerator: (test, label) => (...args) => ({ __kind: 'generated', test, args, label }),
    };

    function matches(filter, mod) {
        if (!filter || typeof filter !== 'object') return false;
        if (filter.__kind === 'props') return filter.props.every((p) => mod.provides.includes(p));
        if (filter.__kind === 'name') return mod.name === filter.name;
        if (filter.__kind === 'all') return filter.filters.every((f) => matches(f, mod));
        if (filter.__kind === 'any') return filter.filters.some((f) => matches(f, mod));
        if (filter.__kind === 'generated') {
            try {
                return !!filter.test(filter.args, undefined, mod.exports);
            } catch {
                return false;
            }
        }
        return false;
    }

    const modules = {
        lookupModule(filter) {
            const found = registered.find((m) => matches(filter, m));
            return found ? [found.exports, 1] : [undefined, undefined];
        },
        getModules(filter, callback, options) {
            const max = options?.max ?? 1;
            let count = 0;
            for (const mod of registered) {
                if (count >= max) break;
                if (matches(filter, mod)) {
                    count++;
                    try {
                        callback(mod.exports, 1);
                    } catch {}
                }
            }
            return () => {};
        },
        waitForModules() {
            return () => {};
        },
    };

    const settingsRegistrations = { loaders: [], sections: [], items: [], errors: [] };

    const patcher = {
        before(target, key, hook) {
            const orig = target[key];
            if (typeof orig !== 'function') throw new Error('nothing to patch: ' + key);
            target[key] = function (...args) {
                const ret = hook(args, this);
                return orig.apply(this, Array.isArray(ret) ? ret : args);
            };
            return () => {
                target[key] = orig;
            };
        },
        after(target, key, hook) {
            const orig = target[key];
            target[key] = function (...args) {
                const ret = orig.apply(this, args);
                return hook(args, ret, this);
            };
            return () => {
                target[key] = orig;
            };
        },
        instead(target, key, hook) {
            const orig = target[key];
            target[key] = function (...args) {
                return hook(args, orig.bind(target), this);
            };
            return () => {
                target[key] = orig;
            };
        },
    };

    const host = {
        react: { React, ReactNative: RN, jsxRuntime: makeJsx(), ReactJSXRuntime: makeJsx() },
        discord: {
            flux,
            design: design ? { Design: DESIGN_STUB } : {},
            actions: {
                AlertActionCreators: {
                    openAlert: (key, element) => modalAlerts.push({ key, element }),
                    closeAlert: () => {},
                },
                ToastActionCreators: {
                    open: (...args) => {
                        const first = args[0];
                        const text =
                            typeof first === 'object' && first !== null
                                ? String(first.content ?? first.text ?? '')
                                : String(args[1]?.text ?? args[1]?.content ?? args[1] ?? '');
                        toasts.push(text);
                    },
                },
                ActionSheetActionCreators: {
                    openLazy: (promise, key) => {
                        actionSheets.push({ key, opened: true });
                        return promise;
                    },
                    open: (key) => {
                        actionSheets.push({ key, opened: true });
                    },
                    hideActionSheet: (key) => {
                        actionSheets.push({ key, closed: true });
                    },
                },
            },
            native: {},
            // Discord's import tracker: the map of module path -> id that
            // @valenced/discord/common/import-tracker exposes. Built from the
            // modules registered so far, so a plugin that looks a module up by
            // path sees the same map the client would have recorded.
            common: {
                // Discord's token module: the semantic colour names a theme can
                // override. Real names the client uses, so a theme that matches
                // on them is exercised here the same way it is on a device.
                tokens: {
                    SemanticColor: {
                        BACKGROUND_PRIMARY: '#313338',
                        BACKGROUND_SECONDARY: '#2b2d31',
                        BACKGROUND_TERTIARY: '#232428',
                        BACKGROUND_ACCENT: '#5865f2',
                        BACKGROUND_MODIFIER_HOVER: '#ffffff0f',
                        CARD_BACKGROUND_DEFAULT: '#232428',
                        MODAL_BACKGROUND: '#313338',
                        BRAND_500: '#5865f2',
                        BRAND_560: '#4752c4',
                        TEXT_NORMAL: '#dbdee1',
                        TEXT_MUTED: '#949ba4',
                        TEXT_LINK: '#00a8fc',
                        INTERACTIVE_NORMAL: '#b5bac1',
                        INTERACTIVE_HOVER: '#dbdee1',
                    },
                    RawColor: { BLUE_345: '#5865f2', DARK_900: '#111214' },
                },
                // Discord exposes the same module as `Tokens` on common, which is
                // what a named import resolves to.
                get Tokens() {
                    return this.tokens;
                },
                get importTracker() {
                    const map = new Map();
                    registered.forEach((mod, index) => {
                        if (mod.path) map.set(mod.path, index);
                    });
                    return { mImportedPaths: map };
                },
            },
            // Path-based lookup, as @valenced/discord/utils/modules/finders
            // documents it: a module is found by the file it was imported from,
            // which survives R8 renaming the component itself.
            utils: {
                modules: {
                    finders: {
                        getModuleWithImportedPath(path, callback) {
                            const found = registered.find((mod) => mod.path === path);
                            if (found) {
                                try {
                                    callback(found.exports, 1);
                                } catch (error) {
                                    settingsRegistrations.errors.push(error);
                                }
                            }
                            return () => {};
                        },
                        getModule(path, callback) {
                            return host.discord.utils.modules.finders.getModuleWithImportedPath(path, callback);
                        },
                        lookupModuleWithImportedPath(path) {
                            const found = registered.find((mod) => mod.path === path);
                            return found ? [found.exports, 1] : [undefined, undefined];
                        },
                    },
                },
            },
            // Discord settings registration, as documented under
            // @valenced/discord/modules/settings. Loaded already, so the
            // callback runs immediately like a real client does.
            modules: {
                settings: {
                    onSettingsModulesLoaded(callback) {
                        settingsRegistrations.loaders.push(callback);
                        try {
                            callback();
                        } catch (error) {
                            settingsRegistrations.errors.push(error);
                        }
                        return () => {};
                    },
                    registerSettingsSection(key, config) {
                        settingsRegistrations.sections.push({ key, config });
                        return () => {};
                    },
                    registerSettingsItem(key, config) {
                        settingsRegistrations.items.push({ key, config });
                        return () => {};
                    },
                },
            },
        },
        patcher,
        modules: {
            finders: { ...modules, filters: finders },
            native: {},
            // Module runtime events, as @valenced/modules/metro/subscriptions
            // documents them. moduleLoaded() fires them, so a verifier can make
            // a lazy module appear the way opening a chat does on a device.
            metro: {
                handlers: [],
                onAnyModuleInitialized(callback) {
                    host.modules.metro.handlers.push(callback);
                    return () => {
                        host.modules.metro.handlers = host.modules.metro.handlers.filter((h) => h !== callback);
                    };
                },
                onAnyModuleFirstRequired(callback) {
                    return host.modules.metro.onAnyModuleInitialized(callback);
                },
            },
        },
        externals: {},
        utils: { discord: { lookupGeneratedIconComponent: () => null } },
        logger: { log() {}, warn() {}, error() {} },
    };
    // Filter helpers live beside the finders, like the documented
    // `@valenced/modules/finders/filters` module.
    host.modules.finders.filters = finders;

    // Theme registration, as the themes API exposes it: a group, then themes
    // inside it. A theme plugin has nothing visual to render, so tests check what
    // it registered and what colours those themes would apply.
    const themes = {
        groups: [],
        themes: [],
        registerGroup(id, group) {
            themes.groups.push({ id, ...(group ?? {}) });
        },
        registerTheme(groupId, id, definition) {
            themes.themes.push({ groupId, id, definition });
        },
    };

    const stored = {};
    const api = {
        cleanup: (fn) => {
            if (typeof fn === 'function') cleanups.push(fn);
        },
        jsonStorage: {
            get: async () => stored,
            set: async (patch) => Object.assign(stored, patch),
            use: () => stored,
            subscribe: () => () => {},
            get cache() {
                return stored;
            },
        },
        logger: { log() {}, warn() {}, error() {} },
        unscoped: host,
        discord: host.discord,
        react: host.react,
        themes,
    };

    return {
        host,
        api,
        stored,
        settings: settingsRegistrations,
        cleanups,
        toasts,
        alerts,
        actionSheets,
        modalAlerts,
        themes,
        fluxHandlers,
        designStub: DESIGN_STUB,
        moduleLoaded() {
            for (const handler of host.modules.metro.handlers.slice()) {
                try {
                    handler();
                } catch {}
            }
        },
        provide(exports, { provides = [], name = '', path = '' } = {}) {
            registered.push({ exports, provides, name, path });
        },
        emit(event, payload) {
            const handler = fluxHandlers.get(event);
            if (!handler) throw new Error('no flux handler for ' + event);
            return handler(payload);
        },
        // Presses a button on the newest system alert, the way a person would.
        tapAlert(label) {
            const current = alerts[alerts.length - 1];
            if (!current) throw new Error('no alert was shown');
            const wanted = String(label).toLowerCase();
            const button = current.buttons.find(
                (item) => String(item?.text ?? '').toLowerCase() === wanted,
            );
            if (!button) {
                throw new Error(
                    'alert has no "' +
                        label +
                        '" button; it has: ' +
                        current.buttons.map((item) => item?.text).join(', '),
                );
            }
            if (typeof button.onPress === 'function') button.onPress();
            return current;
        },
    };
}

function loadBundle(id, sandbox) {
    const file = join(pluginFolder(id), 'build', 'js', 'index.js');
    let code;
    try {
        code = readFileSync(file, 'utf8');
    } catch {
        throw new Error(id + ': build the plugin first (missing ' + file + ')');
    }
    // The client evaluates the bundle and reads `.default`; do the same.
    const loaded = new Function('valenced', 'plugin', 'return ' + code)(sandbox.host, (config) => config);
    const definition = loaded && loaded.default ? loaded.default : loaded;
    if (!definition || typeof definition.start !== 'function') {
        throw new Error(id + ': bundle did not export a Valenced plugin (missing start)');
    }
    if (typeof definition.SettingsComponent !== 'function') {
        throw new Error(id + ': bundle is missing SettingsComponent');
    }
    // Theme plugins register their work in these two, before start.
    for (const hook of ['preInit', 'init']) {
        if (typeof definition[hook] === 'function') {
            try {
                definition[hook](sandbox.api);
            } catch (error) {
                throw new Error(id + ': ' + hook + ' threw — ' + (error?.message ?? error));
            }
        }
    }
    // A plugin that stores settings must ship their defaults; one with no
    // settings at all (Message Deleter keeps nothing) legitimately has none.
    if (definition.jsonStorage && !definition.jsonStorage.default) {
        throw new Error(id + ': bundle is missing jsonStorage defaults');
    }
    return definition;
}

function textOf(node) {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    if (typeof node !== 'object') return '';
    // Discord's Design rows carry their text in props, not children.
    const props = node.props ?? {};
    const labelled = ['title', 'label', 'subLabel', 'description', 'text']
        .map((key) => (typeof props[key] === 'string' ? props[key] : ''))
        .join(' ');
    return (labelled + ' ' + textOf(node.children)).trim();
}

function collect(node, out = []) {
    if (node == null || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const child of node) collect(child, out);
        return out;
    }
    out.push(node);
    collect(node.children, out);
    return out;
}

function pressables(ui) {
    return collect(ui).filter((n) => n?.props?.accessibilityLabel);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = {
    NATIVE_TYPES,
    DESIGN_STUB,
    React,
    createElement,
    createSandbox,
    loadBundle,
    textOf,
    collect,
    pressables,
    tick,
};
