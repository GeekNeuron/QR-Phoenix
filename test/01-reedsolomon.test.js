/**
 * Property-based tests for the Reed-Solomon engine: for random data, random
 * erasure/error placements within the code's theoretical correction capacity,
 * decoding must exactly reconstruct the original codeword.
 *
 * Run with: node test/01-reedsolomon.test.js
 */
require("../core/01-gf256.js");
require("../core/02-reedsolomon.js");
var RS = global.QR.rs;

function randInt(n) {
  return Math.floor(Math.random() * n);
}
function randBytes(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(randInt(256));
  return a;
}
function shuffledIndices(n) {
  var arr = [];
  for (var i = 0; i < n; i++) arr.push(i);
  for (var i2 = arr.length - 1; i2 > 0; i2--) {
    var j = randInt(i2 + 1);
    var tmp = arr[i2];
    arr[i2] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

var trials = 0,
  pass = 0,
  fail = 0;

[
  { dataLen: 8, ecCounts: [6, 10, 16] },
  { dataLen: 30, ecCounts: [10, 22, 30] },
  { dataLen: 118, ecCounts: [30] }, // realistic large QR block size
].forEach(function (cfg) {
  cfg.ecCounts.forEach(function (ecCount) {
    for (var t = 0; t < 150; t++) {
      trials++;
      var data = randBytes(cfg.dataLen);
      var ec = RS.encode(data, ecCount);
      var codeword = data.concat(ec);
      var n = codeword.length;

      var numErasures = randInt(ecCount + 1);
      var maxErrors = Math.floor((ecCount - numErasures) / 2);
      var numErrors = randInt(maxErrors + 1);

      var order = shuffledIndices(n);
      var erasurePositions = order.slice(0, numErasures);
      var errorPositions = order.slice(numErasures, numErasures + numErrors);

      var corrupted = codeword.slice();
      erasurePositions.concat(errorPositions).forEach(function (pos) {
        var v;
        do {
          v = randInt(256);
        } while (v === corrupted[pos]);
        corrupted[pos] = v;
      });

      var result = RS.decode(corrupted, ecCount, erasurePositions);
      var ok = result.ok && result.codewords.every(function (b, i) { return b === codeword[i]; });
      if (ok) pass++;
      else {
        fail++;
        console.error("FAIL", { dataLen: cfg.dataLen, ecCount: ecCount, numErasures: numErasures, numErrors: numErrors });
      }
    }
  });
});

console.log("Reed-Solomon: " + pass + "/" + trials + " trials passed");
if (fail > 0) process.exit(1);
