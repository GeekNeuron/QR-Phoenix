/**
 * Tests the small BCH codes protecting the format-info and version-info
 * strings: every valid codeword must decode cleanly, and every codeword
 * with up to 3 flipped bits must still decode to the original value.
 *
 * Run with: node test/02-bch.test.js
 */
require("../core/04-bch.js");
var BCH = global.QR.bch;

var failures = 0;

for (var ec = 0; ec < 4; ec++) {
  for (var mask = 0; mask < 8; mask++) {
    var bits = BCH.encodeFormat(ec, mask);
    var clean = BCH.decodeFormat(bits);
    if (!clean || clean.ecLevelBits !== ec || clean.mask !== mask) {
      console.error("FAIL clean format", ec, mask);
      failures++;
    }
    for (var t = 0; t < 30; t++) {
      var numFlips = 1 + Math.floor(Math.random() * 3);
      var corrupted = bits;
      var flipped = {};
      while (Object.keys(flipped).length < numFlips) flipped[Math.floor(Math.random() * 15)] = true;
      Object.keys(flipped).forEach(function (b) { corrupted ^= 1 << b; });
      var d = BCH.decodeFormat(corrupted);
      if (!d || d.ecLevelBits !== ec || d.mask !== mask) {
        console.error("FAIL corrupted format", ec, mask, flipped);
        failures++;
      }
    }
  }
}

for (var v = 7; v <= 40; v++) {
  var vbits = BCH.encodeVersion(v);
  var cleanV = BCH.decodeVersion(vbits);
  if (!cleanV || cleanV.version !== v) {
    console.error("FAIL clean version", v);
    failures++;
  }
  for (var t2 = 0; t2 < 20; t2++) {
    var numFlips2 = 1 + Math.floor(Math.random() * 3);
    var corruptedV = vbits;
    var flipped2 = {};
    while (Object.keys(flipped2).length < numFlips2) flipped2[Math.floor(Math.random() * 18)] = true;
    Object.keys(flipped2).forEach(function (b) { corruptedV ^= 1 << b; });
    var d2 = BCH.decodeVersion(corruptedV);
    if (!d2 || d2.version !== v) {
      console.error("FAIL corrupted version", v, flipped2);
      failures++;
    }
  }
}

// Cross-check against known ISO/IEC 18004 Annex C reference values.
var refs = [
  [BCH.encodeFormat(1, 0), 0x77c4], // L, mask 0
  [BCH.encodeFormat(0, 5), 0x40ce], // M, mask 5
  [BCH.encodeFormat(2, 7), 0x083b], // H, mask 7
  [BCH.encodeVersion(7), 0x07c94],
  [BCH.encodeVersion(40), 0x28c69],
];
refs.forEach(function (pair) {
  if (pair[0] !== pair[1]) {
    console.error("FAIL reference mismatch", pair[0].toString(16), "!=", pair[1].toString(16));
    failures++;
  }
});

console.log("BCH tests: " + (failures === 0 ? "all passed" : failures + " FAILURES"));
if (failures > 0) process.exit(1);
