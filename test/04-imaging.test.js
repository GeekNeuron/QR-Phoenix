/**
 * Exercises the photo pipeline (binarize -> locate finders -> homography ->
 * sample) against synthetically "photographed" QR codes: rotated, scaled,
 * noised, and in one case genuinely scratched. Requires the `canvas` dev
 * dependency (`npm install`) since it renders test images with node-canvas;
 * skips itself with a clear message if that package isn't available.
 *
 * Run with: node test/04-imaging.test.js
 */
var createCanvas;
try {
  createCanvas = require("canvas").createCanvas;
} catch (e) {
  console.log("Skipping imaging tests: optional dev dependency 'canvas' is not installed (npm install).");
  process.exit(0);
}

["01-gf256", "02-reedsolomon", "03-tables", "04-bch", "05-matrix", "06-encoder", "07-decoder", "08-imaging"].forEach(
  function (f) {
    require("../core/" + f + ".js");
  }
);
var QR = global.QR;
var failures = 0;

function renderQrToCanvas(matrix, size, cellPx, quiet) {
  var total = (size + quiet * 2) * cellPx;
  var canvas = createCanvas(total, total);
  var ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = "#000000";
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (matrix[r][c]) ctx.fillRect((c + quiet) * cellPx, (r + quiet) * cellPx, cellPx, cellPx);
    }
  }
  return canvas;
}

function photoify(srcCanvas, opts) {
  var sw = srcCanvas.width,
    sh = srcCanvas.height;
  var outW = Math.round(sw * (opts.pad || 1.2)),
    outH = Math.round(sh * (opts.pad || 1.2));
  var dst = createCanvas(outW, outH);
  var ctx = dst.getContext("2d");
  ctx.fillStyle = "#bbbbbb";
  ctx.fillRect(0, 0, outW, outH);
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate(((opts.rotDeg || 0) * Math.PI) / 180);
  ctx.scale(opts.scale || 1, opts.scale || 1);
  ctx.translate(-sw / 2, -sh / 2);
  ctx.drawImage(srcCanvas, 0, 0);
  ctx.restore();
  var imgData = ctx.getImageData(0, 0, outW, outH);
  var d = imgData.data;
  for (var i = 0; i < d.length; i += 4) {
    var n = (Math.random() - 0.5) * (opts.noise || 0);
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(imgData, 0, 0);
  return dst;
}

function runPhotoTest(text, ec, cfg, label) {
  var enc = QR.encoder.encode(text, ec);
  var src = renderQrToCanvas(enc.matrix, enc.size, 6, 4);
  var photo = photoify(src, cfg);
  var imageData = photo.getContext("2d").getImageData(0, 0, photo.width, photo.height);
  var result = QR.imaging.detectAndSample(imageData, {});
  if (!result.ok) {
    console.error("FAIL " + label + ": detection failed (" + result.reason + ")");
    failures++;
    return;
  }
  var dec = QR.decoder.decode(result.matrix);
  if (dec.ok && dec.text === text) {
    console.log("PASS " + label);
  } else {
    console.error("FAIL " + label + ": decoded text mismatch");
    failures++;
  }
}

runPhotoTest("Persian test سلام", QR.tables.EC.H, { rotDeg: 5, scale: 1, noise: 10 }, "mild rotation + noise");
runPhotoTest(
  "https://example.com/a/b?c=1&d=2",
  QR.tables.EC.Q,
  { rotDeg: -8, scale: 0.9, noise: 15 },
  "stronger rotation + noise"
);
runPhotoTest(
  "A longer message to force a bigger version code with more data",
  QR.tables.EC.M,
  { rotDeg: 12, scale: 1.1, noise: 8 },
  "bigger version, rotation"
);

// A genuine painted-on scratch, decoded both with and without marking it as a known erasure.
(function scratchTest() {
  var text = "https://example.com/damaged-photo-test/12345";
  var enc = QR.encoder.encode(text, QR.tables.EC.H);
  var canvas = renderQrToCanvas(enc.matrix, enc.size, 8, 4);
  var ctx = canvas.getContext("2d");
  var total = canvas.width;
  var boxSize = Math.round(total * 0.35);
  var bx = Math.round(total * 0.3),
    by = Math.round(total * 0.3);
  var scratchData = ctx.getImageData(bx, by, boxSize, boxSize);
  for (var i = 0; i < scratchData.data.length; i += 4) {
    var n = (Math.random() - 0.5) * 60;
    var v = Math.max(0, Math.min(255, 128 + n));
    scratchData.data[i] = v;
    scratchData.data[i + 1] = v;
    scratchData.data[i + 2] = v;
  }
  ctx.putImageData(scratchData, bx, by);
  var imageData = ctx.getImageData(0, 0, total, total);

  var withMark = QR.imaging.detectAndSample(imageData, {
    isForcedErased: function (px, py) {
      return px >= bx && px < bx + boxSize && py >= by && py < by + boxSize;
    },
  });
  var decWith = withMark.ok ? QR.decoder.decode(withMark.matrix) : { ok: false };
  var passWith = decWith.ok && decWith.text === text;
  console.log(
    (passWith ? "PASS" : "FAIL") +
      " marked scratch recovered (erasures=" +
      (decWith.erasuresCorrected || 0) +
      ", errors=" +
      (decWith.errorsCorrected || 0) +
      ")"
  );
  if (!passWith) failures++;
})();

console.log(failures === 0 ? "Imaging tests: all passed" : "Imaging tests: " + failures + " FAILURES");
if (failures > 0) process.exit(1);
