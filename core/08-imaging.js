/**
 * QR Phoenix - core/imaging.js
 * -----------------------------------------------------------------------
 * Turns a photo (as raw RGBA pixel data, the same shape browsers and
 * node-canvas both hand back from getImageData) into a module matrix
 * the decoder can consume. Pure array math -- no DOM/canvas calls in
 * here -- so it runs identically in the browser and in a Node test
 * harness using node-canvas, which is how this whole pipeline was
 * validated before ever touching a real photo.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  function toGrayscale(imageData) {
    var w = imageData.width,
      h = imageData.height,
      d = imageData.data;
    var gray = new Float32Array(w * h);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return { data: gray, width: w, height: h };
  }

  function otsuThreshold(gray) {
    var hist = new Array(256).fill(0);
    for (var i = 0; i < gray.data.length; i++) hist[Math.round(gray.data[i]) | 0]++;
    var total = gray.data.length;
    var sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0,
      wB = 0,
      maxVar = -1;
    var bestLo = 127,
      bestHi = 127;
    for (var th = 0; th < 256; th++) {
      wB += hist[th];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += th * hist[th];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar + 1e-9) {
        maxVar = between;
        bestLo = th;
        bestHi = th;
      } else if (Math.abs(between - maxVar) <= 1e-9) {
        bestHi = th; // extend the plateau of equally-good thresholds
      }
    }
    // Picking the middle of the plateau (rather than its first point) matters a lot for
    // clean, near-bimodal images: with a pure black/white input the "best" threshold is
    // any value in the gap between the two intensity clusters, and only the middle of
    // that gap is safely on the correct side of both.
    return Math.round((bestLo + bestHi) / 2) + 0.5;
  }

  function binarize(gray, threshold) {
    var out = new Uint8Array(gray.data.length);
    for (var i = 0; i < gray.data.length; i++) out[i] = gray.data[i] < threshold ? 1 : 0; // 1 = dark/ink
    return { data: out, width: gray.width, height: gray.height };
  }

  // --- Finder pattern detection: scan rows/columns for the 1:1:3:1:1 dark:light:dark:light:dark ratio ---

  function runsInLine(getPixel, length) {
    var runs = [];
    var cur = getPixel(0),
      len = 1;
    for (var i = 1; i < length; i++) {
      var v = getPixel(i);
      if (v === cur) {
        len++;
      } else {
        runs.push({ value: cur, length: len, end: i - 1 });
        cur = v;
        len = 1;
      }
    }
    runs.push({ value: cur, length: len, end: length - 1 });
    return runs;
  }

  // Looks for 5 consecutive runs dark:light:dark:light:dark with the middle dark run
  // roughly 3x the width of the four outer runs (the finder pattern's cross-section).
  function findFinderRunsInLine(runs) {
    var hits = [];
    for (var i = 0; i + 4 < runs.length; i++) {
      var r0 = runs[i],
        r1 = runs[i + 1],
        r2 = runs[i + 2],
        r3 = runs[i + 3],
        r4 = runs[i + 4];
      if (r0.value !== 1 || r1.value !== 0 || r2.value !== 1 || r3.value !== 0 || r4.value !== 1) continue;
      var unit = (r0.length + r1.length + r3.length + r4.length) / 4;
      if (unit < 1) continue;
      var ratio = r2.length / unit;
      if (ratio < 2.0 || ratio > 4.6) continue;
      // require the four outer runs to be roughly consistent with each other
      var maxOuter = Math.max(r0.length, r1.length, r3.length, r4.length);
      var minOuter = Math.min(r0.length, r1.length, r3.length, r4.length);
      if (maxOuter / minOuter > 2.6) continue;
      var start = r0.end - r0.length + 1;
      var end = r4.end;
      var center = (start + end) / 2;
      hits.push({ center: center, moduleSize: (end - start + 1) / 7 });
    }
    return hits;
  }

  // Sorts by key and merges consecutive points whose keys are within `tolerance` of their
  // immediate neighbour. This avoids the "drifting running average" trap of naive online
  // clustering, where a cluster's centroid can wander far enough from the first points in
  // it that a single true peak gets incorrectly split into two.
  function clusterBy(points, keyFn, tolerance) {
    var withKey = points.map(function (p) { return { p: p, key: keyFn(p) }; });
    withKey.sort(function (a, b) { return a.key - b.key; });
    var clusters = [];
    var current = null;
    withKey.forEach(function (item) {
      if (current && item.key - current.lastKey <= tolerance) {
        current.items.push(item.p);
        current.lastKey = item.key;
      } else {
        current = { items: [item.p], lastKey: item.key };
        clusters.push(current);
      }
    });
    clusters.forEach(function (c) {
      var sum = 0;
      c.items.forEach(function (p) { sum += keyFn(p); });
      c.key = sum / c.items.length;
    });
    return clusters;
  }

  /**
   * Scan the whole binarized image for finder-pattern centers.
   * Returns up to a handful of the strongest candidates as {x, y, moduleSize, score}.
   */
  function findFinderCandidates(binary) {
    var w = binary.width,
      h = binary.height;
    var rowHits = []; // {x, y(row index), moduleSize}
    for (var y = 0; y < h; y++) {
      var runs = runsInLine(function (x) {
        return binary.data[y * w + x];
      }, w);
      var hits = findFinderRunsInLine(runs);
      hits.forEach(function (hit) {
        rowHits.push({ x: hit.center, y: y, moduleSize: hit.moduleSize });
      });
    }
    if (rowHits.length === 0) return [];

    // Cluster by x first; a single x-cluster can still contain TWO unrelated finder
    // patterns that happen to share a column (classically: the top-left and bottom-left
    // finders sit almost directly above one another), so each x-cluster is further split
    // into y-contiguous sub-groups before being treated as one candidate.
    var byX = clusterBy(rowHits, function (p) { return p.x; }, 4);
    var byXY = [];
    byX.forEach(function (xCluster) {
      var subClusters = clusterBy(xCluster.items, function (p) { return p.y; }, 8);
      subClusters.forEach(function (yCluster) {
        byXY.push({
          key: xCluster.key,
          items: yCluster.items,
        });
      });
    });
    byXY.sort(function (a, b) { return b.items.length - a.items.length; });
    byX = byXY;

    var candidates = [];
    for (var ci = 0; ci < Math.min(byX.length, 12); ci++) {
      var cluster = byX[ci];
      if (cluster.items.length < 3) continue;
      var avgX = cluster.key;
      var ys = cluster.items.map(function (p) { return p.y; });
      var minY = Math.min.apply(null, ys),
        maxY = Math.max.apply(null, ys);
      var candidateY = (minY + maxY) / 2;
      var avgModuleSize =
        cluster.items.reduce(function (s, p) { return s + p.moduleSize; }, 0) / cluster.items.length;

      // A real finder pattern is about 7 modules tall; the row-hit span should roughly match
      // that (allowing generous slack for perspective/noise). This rejects incidental
      // 1:1:3:1:1-like ratios found in just a few unrelated rows (e.g. inside the data area).
      var expectedSpan = avgModuleSize * 7;
      if (maxY - minY > expectedSpan * 1.6 || maxY - minY < expectedSpan * 0.25) continue;

      // Cross-check vertically through this column to refine the y-center and confirm the pattern.
      var colX = Math.round(avgX);
      if (colX < 0 || colX >= w) continue;
      var colRuns = runsInLine(function (yy) { return binary.data[yy * w + colX]; }, h);
      var colHits = findFinderRunsInLine(colRuns);
      if (colHits.length === 0) continue;
      // pick the column hit closest to our row-based estimate
      colHits.sort(function (a, b) { return Math.abs(a.center - candidateY) - Math.abs(b.center - candidateY); });
      var best = colHits[0];

      candidates.push({
        x: avgX,
        y: best.center,
        moduleSize: (avgModuleSize + best.moduleSize) / 2,
        score: cluster.items.length,
      });
    }
    candidates.sort(function (a, b) { return b.score - a.score; });

    // De-duplicate: the same physical finder can occasionally produce two nearby candidates
    // (e.g. if its column got split across adjacent x-buckets). Keep the higher-scoring one.
    var deduped = [];
    candidates.forEach(function (cand) {
      var dupOf = deduped.find(function (existing) {
        return Math.hypot(existing.x - cand.x, existing.y - cand.y) < cand.moduleSize * 3;
      });
      if (!dupOf) deduped.push(cand);
    });
    return deduped;
  }

  /** Classify exactly 3 finder centers into {tl, tr, bl}. Assumes a roughly upright photo. */
  function classifyFinders(points) {
    if (points.length !== 3) return null;
    var d = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
    var dAB = d(points[0], points[1]),
      dAC = d(points[0], points[2]),
      dBC = d(points[1], points[2]);
    var pairs = [
      { d: dAB, a: 0, b: 1, other: 2 },
      { d: dAC, a: 0, b: 2, other: 1 },
      { d: dBC, a: 1, b: 2, other: 0 },
    ];
    pairs.sort(function (x, y) { return y.d - x.d; });
    var tlIdx = pairs[0].other; // the point opposite the longest side (the diagonal) is top-left
    var others = [0, 1, 2].filter(function (i) { return i !== tlIdx; });
    var tl = points[tlIdx];
    var p1 = points[others[0]],
      p2 = points[others[1]];
    // Of the remaining two, the one further right (larger x, roughly) is top-right, the other bottom-left.
    // (This assumes the photo isn't rotated by more than ~45 degrees.)
    var tr = p1.x >= p2.x ? p1 : p2;
    var bl = p1.x >= p2.x ? p2 : p1;
    return { tl: tl, tr: tr, bl: bl };
  }

  // --- Homography (perspective transform) via Direct Linear Transform on 4 point correspondences ---

  function solveLinearSystem(A, b) {
    var n = b.length;
    for (var i = 0; i < n; i++) A[i].push(b[i]);
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
      var tmp = A[col];
      A[col] = A[pivot];
      A[pivot] = tmp;
      if (Math.abs(A[col][col]) < 1e-12) return null;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var factor = A[r2][col] / A[col][col];
        for (var c = col; c <= n; c++) A[r2][c] -= factor * A[col][c];
      }
    }
    var x = new Array(n);
    for (var i2 = 0; i2 < n; i2++) x[i2] = A[i2][n] / A[i2][i2];
    return x;
  }

  /** Computes the 3x3 homography mapping src[i] -> dst[i] for 4 point pairs. Returns a flat 9-array (h22=1). */
  function computeHomography(src, dst) {
    var A = [],
      b = [];
    for (var i = 0; i < 4; i++) {
      var sx = src[i][0],
        sy = src[i][1],
        dx = dst[i][0],
        dy = dst[i][1];
      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      b.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dy);
    }
    var h = solveLinearSystem(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function applyHomography(H, x, y) {
    var denom = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / denom, (H[3] * x + H[4] * y + H[5]) / denom];
  }

  /**
   * Given detected finder centers (in image pixel space) and an average module pixel size,
   * estimate the QR version/size by measuring finder-to-finder spacing in modules.
   */
  function estimateVersion(tl, tr, bl, moduleSize) {
    var distTR = Math.hypot(tr.x - tl.x, tr.y - tl.y) / moduleSize;
    var distBL = Math.hypot(bl.x - tl.x, bl.y - tl.y) / moduleSize;
    var avgModules = (distTR + distBL) / 2; // distance between finder CENTERS, in modules
    var rawSize = Math.round(avgModules) + 7; // finder centers are 3.5 modules in from each edge
    var version = Math.round((rawSize - 17) / 4);
    version = Math.max(1, Math.min(40, version));
    return version;
  }

  /**
   * Build the full module matrix (values 0/1/null) from a photo, using the finder-pattern
   * homography to locate every module center and sampling a small neighbourhood there.
   *
   * @param imageData {width, height, data} raw RGBA (e.g. from canvas getImageData)
   * @param opts.isForcedErased(px, py) => bool, optional user-painted "known damage" test in pixel space
   */
  function detectAndSample(imageData, opts) {
    opts = opts || {};
    var gray = toGrayscale(imageData);
    var threshold = otsuThreshold(gray);
    var binary = binarize(gray, threshold);

    var candidates = findFinderCandidates(binary);
    if (candidates.length < 3) {
      return { ok: false, reason: "finder-patterns-not-found", candidatesFound: candidates.length };
    }
    var top3 = candidates.slice(0, 3);
    var classified = classifyFinders(top3);
    if (!classified) return { ok: false, reason: "finder-classification-failed" };

    var avgModuleSize = (top3[0].moduleSize + top3[1].moduleSize + top3[2].moduleSize) / 3;
    var version = estimateVersion(classified.tl, classified.tr, classified.bl, avgModuleSize);
    var size = version * 4 + 17;

    // Estimate the 4th (bottom-right) corner by parallelogram completion, then solve the homography
    // mapping ideal module-space finder centers -> detected pixel centers.
    var br = {
      x: classified.tr.x + classified.bl.x - classified.tl.x,
      y: classified.tr.y + classified.bl.y - classified.tl.y,
    };
    var srcModuleSpace = [
      [3.5, 3.5],
      [size - 3.5, 3.5],
      [3.5, size - 3.5],
      [size - 3.5, size - 3.5],
    ];
    var dstPixelSpace = [
      [classified.tl.x, classified.tl.y],
      [classified.tr.x, classified.tr.y],
      [classified.bl.x, classified.bl.y],
      [br.x, br.y],
    ];
    var H = computeHomography(srcModuleSpace, dstPixelSpace);
    if (!H) return { ok: false, reason: "homography-failed" };

    var matrix = new Array(size);
    var confidence = new Array(size);
    var w = imageData.width,
      h = imageData.height;
    for (var r = 0; r < size; r++) {
      matrix[r] = new Array(size);
      confidence[r] = new Array(size);
      for (var c = 0; c < size; c++) {
        var pixel = applyHomography(H, c + 0.5, r + 0.5);
        var px = pixel[0],
          py = pixel[1];
        if (px < 0 || py < 0 || px >= w || py >= h) {
          matrix[r][c] = null;
          confidence[r][c] = 0;
          continue;
        }
        if (opts.isForcedErased && opts.isForcedErased(px, py)) {
          matrix[r][c] = null;
          confidence[r][c] = 0;
          continue;
        }
        // Sample a small 3x3 cross around the projected center for robustness + a confidence score.
        var samples = [];
        var step = Math.max(1, avgModuleSize * 0.15);
        var offsets = [
          [0, 0], [step, 0], [-step, 0], [0, step], [0, -step],
        ];
        for (var oi = 0; oi < offsets.length; oi++) {
          var sx = Math.round(px + offsets[oi][0]);
          var sy = Math.round(py + offsets[oi][1]);
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          samples.push(gray.data[sy * w + sx] < threshold ? 1 : 0);
        }
        if (samples.length === 0) {
          matrix[r][c] = null;
          confidence[r][c] = 0;
          continue;
        }
        var darkCount = samples.reduce(function (s, v) { return s + v; }, 0);
        var agreement = Math.max(darkCount, samples.length - darkCount) / samples.length;
        matrix[r][c] = darkCount >= samples.length / 2 ? 1 : 0;
        confidence[r][c] = agreement;
        // Low agreement among the 5 cross-samples means we're likely straddling a module edge
        // or sitting on real damage/noise -- safer to call it an erasure than guess.
        if (agreement < 0.7) matrix[r][c] = null;
      }
    }

    return {
      ok: true,
      matrix: matrix,
      confidence: confidence,
      version: version,
      size: size,
      finders: classified,
      homography: H,
      threshold: threshold,
    };
  }

  root.QR = root.QR || {};
  root.QR.imaging = {
    toGrayscale: toGrayscale,
    otsuThreshold: otsuThreshold,
    binarize: binarize,
    findFinderCandidates: findFinderCandidates,
    classifyFinders: classifyFinders,
    computeHomography: computeHomography,
    applyHomography: applyHomography,
    estimateVersion: estimateVersion,
    detectAndSample: detectAndSample,
  };
})(typeof window !== "undefined" ? window : global);
