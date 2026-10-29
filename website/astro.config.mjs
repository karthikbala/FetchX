import { defineConfig } from 'astro/config';
export default defineConfig({
 output:'static',
 site:'https://fetch.headrun.ai',
 trailingSlash:'never',
 build:{format:'file'},
 // Keep executable scripts external so the deployed Content Security Policy can stay strict.
 vite:{build:{assetsInlineLimit:0}},
 devToolbar:{enabled:false},
});
