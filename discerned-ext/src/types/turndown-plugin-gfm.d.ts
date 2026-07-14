// Ambient type declaration for turndown-plugin-gfm (ships no .d.ts).
// Each export is a Turndown plugin (a function taking the TurndownService).
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  type TurndownPlugin = (service: TurndownService) => void;
  export const gfm: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
}
