/**
 * QR Phoenix - core/gf256.js
 * -----------------------------------------------------------------------
 * Arithmetic over GF(256), the finite field QR codes use for their
 * Reed-Solomon error-correcting code. QR uses the primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D), exactly as specified in ISO/IEC 18004.
 *
 * Everything else in this project (Reed-Solomon encode/decode, generator
 * polynomials, erasure correction) is built on top of the exp/log tables
 * generated here.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var EXP = new Uint8Array(512); // extended to 512 so exp[i] wraps without a modulo in hot loops
  var LOG = new Uint8Array(256);

  (function buildTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // reduce modulo the primitive polynomial
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function gfDiv(a, b) {
    if (b === 0) throw new Error("GF(256): division by zero");
    if (a === 0) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  }

  function gfInv(a) {
    if (a === 0) throw new Error("GF(256): 0 has no inverse");
    return EXP[255 - LOG[a]];
  }

  function gfPow(a, n) {
    if (a === 0) return n === 0 ? 1 : 0;
    return EXP[(LOG[a] * n) % 255 < 0 ? ((LOG[a] * n) % 255) + 255 : (LOG[a] * n) % 255];
  }

  // Multiply two polynomials given as coefficient arrays, highest degree first.
  function polyMul(p, q) {
    var out = new Array(p.length + q.length - 1).fill(0);
    for (var i = 0; i < p.length; i++) {
      if (p[i] === 0) continue;
      var lp = LOG[p[i]];
      for (var j = 0; j < q.length; j++) {
        if (q[j] === 0) continue;
        out[i + j] ^= EXP[lp + LOG[q[j]]];
      }
    }
    return out;
  }

  // Evaluate polynomial p (highest degree first) at x using Horner's method.
  function polyEval(p, x) {
    var y = p[0];
    for (var i = 1; i < p.length; i++) {
      y = gfMul(y, x) ^ p[i];
    }
    return y;
  }

  root.QR = root.QR || {};
  root.QR.gf256 = {
    EXP: EXP,
    LOG: LOG,
    mul: gfMul,
    div: gfDiv,
    inv: gfInv,
    pow: gfPow,
    polyMul: polyMul,
    polyEval: polyEval,
  };
})(typeof window !== "undefined" ? window : global);
