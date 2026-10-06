// Blueberry colors from the design canvas.
(function (root) {
  const P = {
    berry1: '#A9BCFF',  // light periwinkle
    berry2: '#6C86F5',
    berry3: '#4254D6',
    berry4: '#2B2F8F',  // deep indigo
    nose: '#1C1F66',
    ink: '#17151F',
    inkSoft: '#B9B2CC',
    panel: '#1E1B29',
    gradientStops: [0, 0.34, 0.68, 1],
    rgba(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    },
  };
  P.gradient = [P.berry1, P.berry2, P.berry3, P.berry4];
  if (typeof module !== 'undefined' && module.exports) module.exports = P; else root.BlueyPalette = P;
})(typeof window !== 'undefined' ? window : globalThis);
