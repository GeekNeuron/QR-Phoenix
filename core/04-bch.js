/**
 * QR Phoenix - core/bch.js
 * -----------------------------------------------------------------------
 * The 15-bit format info string (EC level + mask pattern) and, for
 * version >= 7, the 18-bit version info string are themselves protected
 * by their own small error-correcting (BCH) codes -- QR codes have
 * "redundancy about their own redundancy". We generate every valid
 * codeword once and decode by nearest Hamming distance, which is exact
 * for these code parameters (format: corrects <=3 bit errors, version:
 * corrects <=3 bit errors) and much simpler than implementing a second
 * BCH algebraic decoder.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  function bitLength(n) {
    var l = 0;
    while (n > 0) {
      l++;
      n >>>= 1;
    }
    return l || 1;
  }

  // Format info: 5 data bits -> 15 bit BCH(15,5) code, generator 0x537, then XOR mask 0x5412.
  var FORMAT_GENERATOR = 0x537;
  var FORMAT_MASK = 0x5412;

  function encodeFormat(ecLevelBits, maskPattern) {
    var data = (ecLevelBits << 3) | maskPattern; // 5 bits
    var rem = bchDivide(data << 10, FORMAT_GENERATOR, 10);
    var code = ((data << 10) | rem) ^ FORMAT_MASK;
    return code & 0x7fff;
  }

  // Version info (v>=7): 6 data bits -> 18 bit BCH(18,6) code, generator 0x1F25, no mask.
  var VERSION_GENERATOR = 0x1f25;

  function encodeVersion(version) {
    var rem = bchDivide(version << 12, VERSION_GENERATOR, 12);
    return ((version << 12) | rem) & 0x3ffff;
  }

  function bchDivide(value, generator, degree) {
    var genBits = bitLength(generator) - 1; // degree of generator poly
    var msbPos = bitLength(value) - 1;
    for (var shift = msbPos; shift >= genBits; shift--) {
      if (value & (1 << shift)) {
        value ^= generator << (shift - genBits);
      }
    }
    return value;
  }

  function hammingDistance(a, b) {
    var x = a ^ b,
      d = 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
    return d;
  }

  // Precompute every valid 15-bit format string, indexed by [ecLevelBits][maskPattern].
  var ALL_FORMAT_STRINGS = [];
  (function buildFormatTable() {
    for (var ec = 0; ec < 4; ec++) {
      for (var mask = 0; mask < 8; mask++) {
        ALL_FORMAT_STRINGS.push({ ec: ec, mask: mask, bits: encodeFormat(ec, mask) });
      }
    }
  })();

  var ALL_VERSION_STRINGS = [];
  (function buildVersionTable() {
    for (var v = 7; v <= 40; v++) {
      ALL_VERSION_STRINGS.push({ version: v, bits: encodeVersion(v) });
    }
  })();

  /** Decode a possibly-corrupted 15-bit format string; returns {ecLevelBits, mask, bitErrors} or null. */
  function decodeFormat(bits) {
    var best = null,
      bestDist = 99;
    for (var i = 0; i < ALL_FORMAT_STRINGS.length; i++) {
      var d = hammingDistance(bits, ALL_FORMAT_STRINGS[i].bits);
      if (d < bestDist) {
        bestDist = d;
        best = ALL_FORMAT_STRINGS[i];
      }
    }
    if (bestDist > 3) return null; // cannot reliably correct beyond 3 bit errors
    return { ecLevelBits: best.ec, mask: best.mask, bitErrors: bestDist };
  }

  /** Decode a possibly-corrupted 18-bit version string; returns {version, bitErrors} or null. */
  function decodeVersion(bits) {
    var best = null,
      bestDist = 99;
    for (var i = 0; i < ALL_VERSION_STRINGS.length; i++) {
      var d = hammingDistance(bits, ALL_VERSION_STRINGS[i].bits);
      if (d < bestDist) {
        bestDist = d;
        best = ALL_VERSION_STRINGS[i];
      }
    }
    if (bestDist > 3) return null;
    return { version: best.version, bitErrors: bestDist };
  }

  // Maps our internal EC index (tables.EC: L=0,M=1,Q=2,H=3) to the 2-bit
  // values ISO/IEC 18004 actually uses inside the format string: L=01,M=00,Q=11,H=10.
  var EC_INDEX_TO_SPEC_BITS = [1, 0, 3, 2];
  var SPEC_BITS_TO_EC_INDEX = [1, 0, 3, 2]; // the mapping is its own inverse

  root.QR = root.QR || {};
  root.QR.bch = {
    encodeFormat: encodeFormat,
    encodeVersion: encodeVersion,
    decodeFormat: decodeFormat,
    decodeVersion: decodeVersion,
    ecIndexToSpecBits: EC_INDEX_TO_SPEC_BITS,
    specBitsToEcIndex: SPEC_BITS_TO_EC_INDEX,
  };
})(typeof window !== "undefined" ? window : global);
