// Ambient type for Vite's `?raw` imports (the editor stylesheet is inlined
// this way in resolve-name.ts). Referenced from there via a triple-slash
// directive so `tsc` sees it even though dashboard/ isn't in the root
// tsconfig `include` — the test suite pulls resolve-name.ts into the program.
declare module '*?raw' {
  const content: string;
  export default content;
}
