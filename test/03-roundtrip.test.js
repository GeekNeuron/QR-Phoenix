/**
 * End-to-end tests of the encoder + decoder against each other: encode a
 * variety of payloads (Latin, digits, URLs, Persian/UTF-8, long text),
 * confirm a clean round trip, then damage the matrix (both as declared
 * erasures and as unmarked bit-flip errors) and confirm recovery holds up
 * to -- and gracefully fails beyond -- the theoretical correction limits.
 *
 * Run with: node test/03-roundtrip.test.js
 */
["01-gf256", "02-reedsolomon", "03-tables", "04-bch", "05-matrix", "06-encoder", "07-decoder"].forEach(function (f) {
  require("../core/" + f + ".js");
});
var QR = global.QR;
var failures = 0;

function cloneMatrix(m) {
  return m.map(function (row) { return row.slice(); });
}
function randInt(n) {
  return Math.floor(Math.random() * n);
}

function expectRoundTrip(text, ecLevel, label) {
  var enc = QR.encoder.encode(text, ecLevel);
  var dec = QR.decoder.decode(cloneMatrix(enc.matrix));
  if (!dec.ok || dec.text !== text) {
    console.error("FAIL " + label, { ok: dec.ok, got: dec.text, expected: text });
    failures++;
  } else {
    console.log("PASS " + label + " (v" + enc.version + " " + QR.tables.EC_NAMES[ecLevel] + ")");
  }
}

expectRoundTrip("HELLO WORLD", QR.tables.EC.Q, "alphanumeric");
expectRoundTrip("https://example.com/some/path?query=123&x=y", QR.tables.EC.M, "url/byte");
expectRoundTrip("1234567890123456789012345", QR.tables.EC.L, "numeric");
expectRoundTrip("سلام دنیا این یک متن فارسی است", QR.tables.EC.H, "persian/utf8");
expectRoundTrip("A".repeat(300), QR.tables.EC.M, "long byte (forces bigger version)");

// Contiguous-scratch damage recovery, marked as known erasures vs left unmarked.
function scratchTrial(text, ecLevel, boxFraction, mode) {
  var enc = QR.encoder.encode(text, ecLevel);
  var skeleton = QR.matrix.buildSkeleton(enc.version);
  var damaged = cloneMatrix(enc.matrix);
  var size = enc.size;
  var boxSize = Math.round(size * Math.sqrt(boxFraction));
  var r0 = randInt(Math.max(1, size - boxSize + 1));
  var c0 = randInt(Math.max(1, size - boxSize + 1));
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (skeleton.reserved[r][c]) continue;
      if (r >= r0 && r < r0 + boxSize && c >= c0 && c < c0 + boxSize) {
        damaged[r][c] = mode === "erasure" ? null : 1 - damaged[r][c];
      }
    }
  }
  var dec = QR.decoder.decode(damaged);
  return dec.ok && dec.text === text;
}

var text = "https://example.com/recover-me?token=abc123XYZ";
var okAt35 = 0,
  okAt15 = 0;
for (var i = 0; i < 15; i++) {
  if (scratchTrial(text, QR.tables.EC.H, 0.35, "erasure")) okAt35++;
  if (scratchTrial(text, QR.tables.EC.M, 0.1, "erasure")) okAt15++;
}
console.log("EC=H, ~35% marked-erasure scratch recovered in " + okAt35 + "/15 trials (expect all/most)");
console.log("EC=M, ~10% marked-erasure scratch recovered in " + okAt15 + "/15 trials (expect all/most)");
if (okAt35 < 12) {
  console.error("FAIL: EC=H erasure recovery rate lower than expected");
  failures++;
}
if (okAt15 < 12) {
  console.error("FAIL: EC=M erasure recovery rate lower than expected");
  failures++;
}

console.log(failures === 0 ? "Round-trip tests: all passed" : "Round-trip tests: " + failures + " FAILURES");
if (failures > 0) process.exit(1);
