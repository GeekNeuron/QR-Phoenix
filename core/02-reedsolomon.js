/**
 * QR Phoenix - core/reedsolomon.js
 * -----------------------------------------------------------------------
 * Reed-Solomon encoding AND decoding over GF(256), with support for
 * "erasures" -- symbols whose *position* is known to be unreadable
 * (a scratch, a torn corner, a smudge marked by the user) as opposed to
 * ordinary unknown errors.
 *
 * This distinction is the mathematical heart of this whole project:
 * a Reed-Solomon code that can correct t unknown errors can correct
 * up to 2t erasures, because knowing WHERE the damage is removes half
 * the work the decoder normally has to do (locating the damage).
 * That is why marking scratched/torn regions on a QR code (instead of
 * just letting the decoder guess) roughly doubles how much damage can
 * be recovered from.
 *
 * All polynomials are represented as plain arrays of byte values,
 * highest-degree coefficient first -- e.g. the polynomial
 *   3x^2 + 0x + 5
 * is represented as [3, 0, 5]. This matches how a codeword itself is
 * naturally written out (first transmitted byte = highest degree term).
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var GF = root.QR.gf256;
  var mul = GF.mul,
    inv = GF.inv,
    EXP = GF.EXP,
    LOG = GF.LOG;

  function polyEval(p, x) {
    return GF.polyEval(p, x);
  }

  function polyMul(p, q) {
    return GF.polyMul(p, q);
  }

  function stripLeading(p) {
    var i = 0;
    while (i < p.length - 1 && p[i] === 0) i++;
    return p.slice(i);
  }

  function degree(p) {
    var s = stripLeading(p);
    if (s.length === 1 && s[0] === 0) return -1; // the zero polynomial
    return s.length - 1;
  }

  function polyXor(a, b) {
    var len = Math.max(a.length, b.length);
    var out = new Array(len).fill(0);
    for (var i = 0; i < a.length; i++) out[len - a.length + i] ^= a[i];
    for (var j = 0; j < b.length; j++) out[len - b.length + j] ^= b[j];
    return out;
  }

  // Polynomial long division in GF(256): dividend = quotient*divisor + remainder
  function polyDivMod(dividend, divisor) {
    divisor = stripLeading(divisor);
    var out = dividend.slice();
    var leadInv = inv(divisor[0]);
    var lastPossibleShift = out.length - divisor.length;
    var quotient = new Array(Math.max(0, lastPossibleShift + 1)).fill(0);
    for (var i = 0; i <= lastPossibleShift; i++) {
      var coef = out[i];
      // The quotient term at this position is coef / divisor[0], i.e. coef * leadInv
      // -- NOT coef itself (that was an earlier bug here: synthetic division zeroes
      // out[i] as a side effect, so the *scaled* value must be captured, not the raw one).
      var factor = mul(coef, leadInv);
      quotient[i] = factor;
      if (coef !== 0) {
        for (var j = 0; j < divisor.length; j++) {
          out[i + j] ^= mul(divisor[j], factor);
        }
      }
    }
    var split = Math.max(0, out.length - (divisor.length - 1));
    return {
      quotient: stripLeading(quotient),
      remainder: stripLeading(out.slice(split)),
    };
  }

  // Keep only the terms of degree < m (i.e. poly mod x^m), returned with length m.
  function modXPow(p, m) {
    var out = new Array(m).fill(0);
    var take = Math.min(m, p.length);
    for (var i = 0; i < take; i++) {
      out[m - take + i] = p[p.length - take + i];
    }
    return out;
  }

  /** Generator polynomial g(x) = (x - a^0)(x - a^1)...(x - a^(degree-1)), monic. */
  function generatorPoly(degree) {
    var g = [1];
    for (var i = 0; i < degree; i++) {
      g = polyMul(g, [1, EXP[i]]); // (x + a^i), '+' == '-' in GF(2^k)
    }
    return g;
  }

  var generatorCache = {};
  function cachedGenerator(degree) {
    if (!generatorCache[degree]) generatorCache[degree] = generatorPoly(degree);
    return generatorCache[degree];
  }

  /**
   * Systematic Reed-Solomon encode.
   * @param data array of byte values (the message)
   * @param ecCount how many error-correction bytes to produce
   * @returns array of `ecCount` EC bytes
   */
  function encode(data, ecCount) {
    var gen = cachedGenerator(ecCount);
    var msg = data.concat(new Array(ecCount).fill(0));
    var leadInv = 1; // generator is monic, no need to invert
    for (var i = 0; i < data.length; i++) {
      var coef = msg[i];
      if (coef !== 0) {
        for (var j = 0; j < gen.length; j++) {
          msg[i + j] ^= mul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  /**
   * Reed-Solomon decode with combined error + erasure correction.
   *
   * @param received   array of byte values: data codewords followed by EC codewords,
   *                   in the exact order they were transmitted (may contain damage).
   * @param ecCount    number of EC codewords (the last `ecCount` entries of `received`)
   * @param erasures   array of 0-based indices into `received` that are KNOWN to be
   *                   unreadable (positions, not values -- the values there are ignored).
   * @returns {
   *   ok: boolean,
   *   codewords: corrected array (only meaningful if ok),
   *   errorsCorrected: number of *unknown-location* byte errors fixed,
   *   erasuresCorrected: number of *known-location* erasures fixed,
   *   reason: string, present when !ok
   * }
   */
  function decode(received, ecCount, erasures) {
    erasures = erasures || [];
    var n = received.length;
    var t2 = ecCount; // number of syndromes = number of EC codewords

    if (erasures.length > ecCount) {
      return { ok: false, reason: "erasures-exceed-ec-capacity", errorsCorrected: 0, erasuresCorrected: 0 };
    }

    // 1. Syndromes S_i = c(a^i) for i = 0..t2-1, stored high-degree-first as [S_{t2-1},...,S_0]
    var allZero = true;
    var sHigh = new Array(t2);
    for (var i = 0; i < t2; i++) {
      var s = polyEval(received, EXP[i]);
      if (s !== 0) allZero = false;
      sHigh[t2 - 1 - i] = s;
    }
    if (allZero) {
      // No damage at all detected by the parity bytes themselves.
      return { ok: true, codewords: received.slice(), errorsCorrected: 0, erasuresCorrected: 0 };
    }

    // 2. Erasure locator Lambda0(x) = prod (1 - X_k x), X_k = a^(n-1-pos)
    var lambda0 = [1];
    for (var e = 0; e < erasures.length; e++) {
      var loc = n - 1 - erasures[e];
      var Xk = EXP[((loc % 255) + 255) % 255];
      lambda0 = polyMul(lambda0, [Xk, 1]);
    }

    // 3. Modified syndrome T(x) = (Lambda0 * S) mod x^(t2)
    var T = modXPow(polyMul(lambda0, sHigh), t2);

    // 4. Extended Euclidean algorithm to find the additional (unknown-location) error locator.
    var rho = erasures.length;
    var threshold = Math.floor((t2 + rho) / 2); // stop once deg(remainder) < threshold
    var r0 = [1].concat(new Array(t2).fill(0)); // x^t2
    var r1 = stripLeading(T);
    var u0 = [0];
    var u1 = [1];
    var guard = 0;
    while (degree(r1) >= threshold && degree(r1) >= 0 && guard < 64) {
      guard++;
      var dm = polyDivMod(r0, r1);
      var q = dm.quotient;
      var rem = dm.remainder;
      var newU = polyXor(u0, polyMul(q, u1));
      r0 = r1;
      u0 = u1;
      r1 = rem;
      u1 = newU;
    }
    var sigma = stripLeading(u1); // additional error locator (unknown positions)
    var omega = stripLeading(r1); // combined errata evaluator

    var nu = degree(sigma); // number of *additional* unknown-location errors
    if (nu < 0) nu = 0;

    if (2 * nu + rho > t2) {
      return { ok: false, reason: "too-much-damage", errorsCorrected: 0, erasuresCorrected: 0 };
    }

    // 5. Total errata locator Lambda(x) = Lambda0(x) * sigma(x)
    var lambda = polyMul(lambda0, sigma);
    var lambdaDeg = degree(lambda);

    if (lambdaDeg <= 0) {
      // Only erasures, and sigma turned out constant -- but we still verified allZero==false,
      // so if lambdaDeg is 0 there is nothing to locate, which is inconsistent; bail out safely.
      if (lambdaDeg === 0 && rho === 0) {
        return { ok: false, reason: "undetermined", errorsCorrected: 0, erasuresCorrected: 0 };
      }
    }

    // 6. Find roots of Lambda among the n physically valid codeword positions.
    var errataPositions = [];
    var errataX = [];
    for (var k = 0; k < n; k++) {
      var l = n - 1 - k;
      var Xk2 = EXP[((l % 255) + 255) % 255];
      var XkInv = inv(Xk2);
      if (polyEval(lambda, XkInv) === 0) {
        errataPositions.push(k);
        errataX.push(Xk2);
      }
    }

    if (errataPositions.length !== lambdaDeg) {
      return { ok: false, reason: "root-count-mismatch", errorsCorrected: 0, erasuresCorrected: 0 };
    }

    // 7. Formal derivative of Lambda (char-2 field: keep only odd-degree terms, shift down).
    var lambdaLowDeg = lambdaDeg; // low-first coeffs: low[i] = lambda[len-1-i]
    var lowLambda = new Array(lambdaLowDeg + 1);
    for (var ii = 0; ii <= lambdaLowDeg; ii++) lowLambda[ii] = lambda[lambda.length - 1 - ii];
    var derivLow = [];
    for (var d = 1; d <= lambdaLowDeg; d++) {
      derivLow.push(d % 2 === 1 ? lowLambda[d] : 0);
    }
    function evalLow(pLow, x) {
      var y = 0,
        xp = 1;
      for (var m = 0; m < pLow.length; m++) {
        if (pLow[m] !== 0) y ^= mul(pLow[m], xp);
        xp = mul(xp, x);
      }
      return y;
    }

    // 8. Forney's formula for each errata position: e_k = X_k * Omega(X_k^-1) / Lambda'(X_k^-1)
    var corrected = received.slice();
    for (var p = 0; p < errataPositions.length; p++) {
      var pos = errataPositions[p];
      var Xk = errataX[p];
      var XkInv2 = inv(Xk);
      var omegaVal = polyEval(omega, XkInv2);
      var derivVal = evalLow(derivLow, XkInv2);
      if (derivVal === 0) {
        return { ok: false, reason: "forney-zero-derivative", errorsCorrected: 0, erasuresCorrected: 0 };
      }
      var magnitude = mul(Xk, mul(omegaVal, inv(derivVal)));
      corrected[pos] ^= magnitude;
    }

    var erasuresFixed = 0,
      errorsFixed = 0;
    var erasureSet = {};
    for (var ei = 0; ei < erasures.length; ei++) erasureSet[erasures[ei]] = true;
    for (var pi = 0; pi < errataPositions.length; pi++) {
      if (erasureSet[errataPositions[pi]]) erasuresFixed++;
      else errorsFixed++;
    }

    return {
      ok: true,
      codewords: corrected,
      errorsCorrected: errorsFixed,
      erasuresCorrected: erasuresFixed,
    };
  }

  root.QR.rs = {
    generatorPoly: generatorPoly,
    encode: encode,
    decode: decode,
  };
})(typeof window !== "undefined" ? window : global);
