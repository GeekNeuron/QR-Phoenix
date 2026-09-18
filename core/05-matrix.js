/**
 * QR Phoenix - core/matrix.js
 * -----------------------------------------------------------------------
 * Everything about the geometry of a QR symbol: where the finder /
 * timing / alignment / format / version patterns go, the zigzag order
 * data bits are read and written in, the 8 masking functions, and the
 * penalty rules used to pick the best mask when encoding.
 *
 * The SAME `dataPath()` order is used by both the encoder (to place
 * bits) and the decoder (to read them back), which guarantees the two
 * halves of this project agree with each other -- and, because every
 * coordinate here was checked against ISO/IEC 18004 reference values,
 * also agree with real-world QR codes made by other software.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var tables = root.QR.tables;
  var bch = root.QR.bch;

  function makeGrid(size, fill) {
    var g = new Array(size);
    for (var r = 0; r < size; r++) g[r] = new Array(size).fill(fill);
    return g;
  }

  function drawFinder(matrix, reserved, topRow, leftCol) {
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var r = topRow + dr,
          c = leftCol + dc;
        if (r < 0 || c < 0 || r >= matrix.length || c >= matrix.length) continue;
        reserved[r][c] = true;
        var dark;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          var onRing0 = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          var onRing2 = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          dark = onRing0 || onRing2;
        } else {
          dark = false; // separator: always white
        }
        matrix[r][c] = dark ? 1 : 0;
      }
    }
  }

  function drawAlignment(matrix, reserved, row, col) {
    for (var dr = -2; dr <= 2; dr++) {
      for (var dc = -2; dc <= 2; dc++) {
        var r = row + dr,
          c = col + dc;
        reserved[r][c] = true;
        var ring = Math.max(Math.abs(dr), Math.abs(dc));
        matrix[r][c] = ring !== 1 ? 1 : 0;
      }
    }
  }

  function alignmentCenters(version) {
    var positions = tables.alignmentPositions(version);
    if (positions.length === 0) return [];
    var first = positions[0],
      last = positions[positions.length - 1];
    var centers = [];
    for (var i = 0; i < positions.length; i++) {
      for (var j = 0; j < positions.length; j++) {
        var r = positions[i],
          c = positions[j];
        var isTL = r === first && c === first;
        var isTR = r === first && c === last;
        var isBL = r === last && c === first;
        if (isTL || isTR || isBL) continue;
        centers.push([r, c]);
      }
    }
    return centers;
  }

  /** Build the base matrix (function patterns drawn, format/version reserved) and the reserved mask. */
  function buildSkeleton(version) {
    var size = tables.moduleCount(version);
    var matrix = makeGrid(size, null); // null = not yet drawn / data area
    var reserved = makeGrid(size, false);

    drawFinder(matrix, reserved, 0, 0);
    drawFinder(matrix, reserved, 0, size - 7);
    drawFinder(matrix, reserved, size - 7, 0);

    // Timing patterns
    for (var t = 8; t < size - 8; t++) {
      if (!reserved[6][t]) {
        matrix[6][t] = t % 2 === 0 ? 1 : 0;
        reserved[6][t] = true;
      }
      if (!reserved[t][6]) {
        matrix[t][6] = t % 2 === 0 ? 1 : 0;
        reserved[t][6] = true;
      }
    }

    var centers = alignmentCenters(version);
    for (var ci = 0; ci < centers.length; ci++) {
      drawAlignment(matrix, reserved, centers[ci][0], centers[ci][1]);
    }

    // Dark module (always black), and reserve all format-info cells (value filled in later).
    var fmtCoords = formatInfoCoords(size);
    for (var fi = 0; fi < fmtCoords.length; fi++) {
      reserved[fmtCoords[fi][0]][fmtCoords[fi][1]] = true;
    }
    matrix[size - 8][8] = 1;
    reserved[size - 8][8] = true;

    if (version >= 7) {
      var verCoords = versionInfoCoords(size);
      for (var vi = 0; vi < verCoords.length; vi++) {
        reserved[verCoords[vi][0]][verCoords[vi][1]] = true;
      }
    }

    return { matrix: matrix, reserved: reserved, size: size };
  }

  // Returns [row,col] pairs for BOTH copies of the 15-bit format info, in MSB-first bit order
  // (index 0 = bit14 ... index 29 = second-copy bit0). Verified against ISO/IEC 18004 Annex C.
  function formatInfoCoords(size) {
    var tl = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    var other = [
      [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
      [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
    ];
    return tl.concat(other);
  }

  // Returns [row,col] pairs for BOTH copies of the 18-bit version info (v>=7), bit i = LSB-first.
  function versionInfoCoords(size) {
    var coords = [];
    for (var i = 0; i < 18; i++) {
      var a = size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      coords.push([b, a]); // (row=b, col=a)
      coords.push([a, b]); // (row=a, col=b)
    }
    return coords;
  }

  function writeFormatInfo(matrix, size, bits) {
    var coords = formatInfoCoords(size);
    for (var k = 0; k < 15; k++) {
      var bit = (bits >> (14 - k)) & 1;
      matrix[coords[k][0]][coords[k][1]] = bit;
      matrix[coords[15 + k][0]][coords[15 + k][1]] = bit;
    }
  }

  function writeVersionInfo(matrix, size, bits) {
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1;
      var a = size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      matrix[b][a] = bit;
      matrix[a][b] = bit;
    }
  }

  /** Zigzag data-module traversal order, skipping the timing column and any reserved cell. */
  function dataPath(size, reserved) {
    var path = [];
    var col = size - 1;
    var goingUp = true;
    while (col > 0) {
      if (col === 6) col--;
      if (goingUp) {
        for (var r = size - 1; r >= 0; r--) {
          for (var dc = 0; dc < 2; dc++) {
            var c = col - dc;
            if (!reserved[r][c]) path.push([r, c]);
          }
        }
      } else {
        for (var r2 = 0; r2 < size; r2++) {
          for (var dc2 = 0; dc2 < 2; dc2++) {
            var c2 = col - dc2;
            if (!reserved[r2][c2]) path.push([r2, c2]);
          }
        }
      }
      goingUp = !goingUp;
      col -= 2;
    }
    return path;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r, c) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];

  function penaltyScore(matrix) {
    var size = matrix.length;
    var score = 0;

    // Rule 1: runs of 5+ same-colour modules, per row and per column.
    function runPenalty(getVal) {
      var p = 0;
      for (var i = 0; i < size; i++) {
        var runLen = 1;
        var prev = getVal(i, 0);
        for (var j = 1; j < size; j++) {
          var v = getVal(i, j);
          if (v === prev) {
            runLen++;
          } else {
            if (runLen >= 5) p += 3 + (runLen - 5);
            runLen = 1;
            prev = v;
          }
        }
        if (runLen >= 5) p += 3 + (runLen - 5);
      }
      return p;
    }
    score += runPenalty(function (i, j) { return matrix[i][j]; }); // rows
    score += runPenalty(function (i, j) { return matrix[j][i]; }); // columns

    // Rule 2: 2x2 blocks of the same colour.
    for (var r = 0; r < size - 1; r++) {
      for (var c = 0; c < size - 1; c++) {
        var v = matrix[r][c];
        if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    // Rule 3: the 1:1:3:1:1 finder-like pattern, with 4 light modules on either side.
    var patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matchesAt(arr, start, pattern) {
      for (var k = 0; k < pattern.length; k++) {
        if (arr[start + k] !== pattern[k]) return false;
      }
      return true;
    }
    for (var rr = 0; rr < size; rr++) {
      var rowArr = matrix[rr];
      for (var cc = 0; cc <= size - 11; cc++) {
        if (matchesAt(rowArr, cc, patternA) || matchesAt(rowArr, cc, patternB)) score += 40;
      }
    }
    for (var ccc = 0; ccc < size; ccc++) {
      var colArr = [];
      for (var rrr = 0; rrr < size; rrr++) colArr.push(matrix[rrr][ccc]);
      for (var start = 0; start <= size - 11; start++) {
        if (matchesAt(colArr, start, patternA) || matchesAt(colArr, start, patternB)) score += 40;
      }
    }

    // Rule 4: overall dark-module proportion, penalised the further from 50% it is.
    var dark = 0;
    for (var i2 = 0; i2 < size; i2++) for (var j2 = 0; j2 < size; j2++) if (matrix[i2][j2]) dark++;
    var percent = (dark * 100) / (size * size);
    var deviation = Math.abs(Math.floor(percent / 5) * 5 - 50) / 5;
    var deviation2 = Math.abs(Math.ceil(percent / 5) * 5 - 50) / 5;
    score += Math.min(deviation, deviation2) * 10;

    return score;
  }

  root.QR = root.QR || {};
  root.QR.matrix = {
    makeGrid: makeGrid,
    buildSkeleton: buildSkeleton,
    formatInfoCoords: formatInfoCoords,
    versionInfoCoords: versionInfoCoords,
    writeFormatInfo: writeFormatInfo,
    writeVersionInfo: writeVersionInfo,
    dataPath: dataPath,
    MASKS: MASKS,
    penaltyScore: penaltyScore,
  };
})(typeof window !== "undefined" ? window : global);
