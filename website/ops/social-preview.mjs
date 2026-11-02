import sharp from 'sharp';

// Original vector layout, rendered locally for Open Graph and social previews.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse"><path d="M44 0H0V44" fill="none" stroke="#1b2c39" stroke-width=".6"/></pattern><linearGradient id="glow"><stop stop-color="#62dce8"/><stop offset="1" stop-color="#c7f36b"/></linearGradient></defs>
<rect width="1200" height="630" fill="#080d12"/><rect x="690" width="510" height="630" fill="url(#grid)"/>
<g fill="#eef4f8"><path d="M56 47h10l24 30H80zM80 47h10L66 77H56z"/><text x="104" y="77" font-family="Helvetica,sans-serif" font-size="35" font-weight="700">FetchX<tspan fill="#c7f36b">.</tspan></text></g>
<text x="58" y="160" fill="#62dce8" font-family="monospace" font-size="13" letter-spacing="2">WEB SCRAPING API &amp; WEB UNBLOCKER</text>
<text x="54" y="260" fill="#eef4f8" font-family="Helvetica,sans-serif" font-size="74" font-weight="700" letter-spacing="-3">Unlock the web.</text>
<text x="54" y="345" fill="#c7f36b" font-family="Helvetica,sans-serif" font-size="74" font-weight="700" letter-spacing="-3">With one API.</text>
<text x="58" y="403" fill="#9aabbc" font-family="Helvetica,sans-serif" font-size="22">Web access for developers, data teams and AI.</text>
<g font-family="monospace"><rect x="762" y="156" width="330" height="66" rx="7" fill="#111a23" stroke="#314352"/><text x="785" y="195" fill="#eef4f8" font-size="17">01 / REQUEST</text><path d="M928 222v36" stroke="#62dce8" stroke-width="2"/>
<rect x="762" y="258" width="330" height="66" rx="7" fill="#111a23" stroke="#62dce8"/><text x="785" y="297" fill="#62dce8" font-size="17">02 / ACCESS ENGINE</text><path d="M928 324v36" stroke="#c7f36b" stroke-width="2"/>
<rect x="762" y="360" width="330" height="66" rx="7" fill="#14211a" stroke="#c7f36b"/><text x="785" y="399" fill="#c7f36b" font-size="17">03 / RESPONSE</text></g>
<path d="M58 526h1084" stroke="#263340"/><text x="58" y="573" fill="#9aabbc" font-family="monospace" font-size="16">fetchx.ai</text><text x="932" y="573" fill="#9aabbc" font-family="monospace" font-size="12">PRODUCT PREVIEW</text>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile('public/brand/social.png');
console.log('Created FetchX social preview (1200 × 630).');
