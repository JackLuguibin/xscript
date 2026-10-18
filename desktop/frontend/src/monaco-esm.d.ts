// "monaco-esm/..." is a Vite alias for monaco-editor/esm/vs (vite.config.ts). The lean editor loads Monaco's
// contributions as side-effect imports of those plain .js files, which ship no type declarations; TypeScript 6+
// checks side-effect imports (noUncheckedSideEffectImports), so tell it they exist. "*.js?worker" keeps Vite's types.
declare module "monaco-esm/*.js";
