// The Valenced host injects `valenced` (the shared runtime object) and `plugin`
// (the ambient entrypoint wrapper) into the bundle's scope. They cannot be
// imported, so declare them for the typechecker.
declare global {
    var valenced: any;
    var plugin: any;

    // Replaced by esbuild's `define` in build.mjs.
    var __DEV__: boolean;
    var IS_DEV: boolean;
}

export {};
