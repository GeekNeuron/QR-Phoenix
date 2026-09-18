/**
 * QR Phoenix - core/decoder.js
 * -----------------------------------------------------------------------
 * Turns a QR module matrix -- where each cell is 0, 1, or null (meaning
 * "unreadable: scratched, torn, unclear") -- back into text.
 *
 * This is where the erasure-recovery advantage actually pays off: every
 * `null` cell that ends up inside a data/EC codeword is reported to the
 * Reed-Solomon decoder as a known erasure position, which can be
 * corrected far more reliably than if the same damage had been silently
 * guessed at and treated as an ordinary error.
 *
 * Pure logic, no DOM / canvas access -- the image layer (web/app.js) is
 * responsible for turning a photo into this matrix representation.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var tables = root.QR.tables;
  var bch = root.QR.bch;
  var mtx = root.QR.matrix;
  var rs = root.QR.rs;

  var REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3];

  function readBits(matrix, coords) {
    var bits = [];
    for (var i = 0; i < coords.length; i++) {
      bits.push(matrix[coords[i][0]][coords[i][1]]);
    }
    return bits;
  }
  function bitsToInt(bits) {
    var v = 0,
      unknown = false;
    for (var i = 0; i < bits.length; i++) {
      if (bits[i] === null || bits[i] === undefined) {
        unknown = true;
        v = (v << 1) | 0;
      } else {
        v = (v << 1) | bits[i];
      }
    }
    return { value: v >>> 0, hadUnknown: unknown };
  }

  function decodeFormatInfo(matrix, size) {
    var coords = mtx.formatInfoCoords(size);
    var tlBits = readBits(matrix, coords.slice(0, 15));
    var otherBits = readBits(matrix, coords.slice(15, 30));

    var merged = [];
    for (var i = 0; i < 15; i++) {
      var a = tlBits[i],
        b = otherBits[i];
      merged.push(a !== null && a !== undefined ? a : b !== null && b !== undefined ? b : 0);
    }
    var candidates = [merged, tlBits, otherBits];
    var best = null;
    for (var c = 0; c < candidates.length; c++) {
      var bi = bitsToInt(candidates[c]);
      var d = bch.decodeFormat(bi.value);
      if (d && (!best || d.bitErrors < best.bitErrors)) {
        best = d;
      }
    }
    return best; // {ecLevelBits, mask, bitErrors} or null
  }

  function decodeVersionInfo(matrix, size) {
    var coords = mtx.versionInfoCoords(size); // 36 coords: pairs (a-block, b-block) interleaved
    var blockA = [],
      blockB = [];
    for (var i = 0; i < 18; i++) {
      blockA.push(matrix[coords[i * 2][0]][coords[i * 2][1]]);
      blockB.push(matrix[coords[i * 2 + 1][0]][coords[i * 2 + 1][1]]);
    }
    function toIntLSBFirst(bits) {
      var v = 0;
      for (var i = 0; i < bits.length; i++) {
        var bit = bits[i] === null || bits[i] === undefined ? 0 : bits[i];
        v |= bit << i;
      }
      return v >>> 0;
    }
    var merged = [];
    for (var j = 0; j < 18; j++) {
      var a = blockA[j],
        b = blockB[j];
      merged.push(a !== null && a !== undefined ? a : b !== null && b !== undefined ? b : 0);
    }
    var best = null;
    [merged, blockA, blockB].forEach(function (bits) {
      var v = toIntLSBFirst(bits);
      var d = bch.decodeVersion(v);
      if (d && (!best || d.bitErrors < best.bitErrors)) best = d;
    });
    return best;
  }

  /**
   * @param matrix size x size array of 0/1/null
   * @returns diagnostics + best-effort recovered text
   */
  function decode(matrix) {
    var size = matrix.length;
    var version = Math.round((size - 17) / 4);
    if (version < 1 || version > tables.MAX_VERSION) {
      return { ok: false, reason: "unsupported-size", size: size };
    }

    var fmt = decodeFormatInfo(matrix, size);
    if (!fmt) return { ok: false, reason: "format-info-unreadable" };
    var ecLevel = bch.specBitsToEcIndex[fmt.ecLevelBits];
    var mask = fmt.mask;

    if (version >= 7) {
      var ver = decodeVersionInfo(matrix, size);
      if (ver && ver.version !== version) {
        // Trust the explicitly-encoded version number over the geometric guess when they disagree.
        version = ver.version;
      }
    }

    var skeleton = mtx.buildSkeleton(version);
    var path = mtx.dataPath(skeleton.size, skeleton.reserved);
    var info = tables.blockInfo(version, ecLevel);
    var remainderCount = REMAINDER_BITS[version] || 0;
    var expectedDataBits = path.length - remainderCount;

    // Unmask and collect bits (null propagates as "unknown").
    var bits = new Array(path.length);
    for (var i = 0; i < path.length; i++) {
      var r = path[i][0],
        c = path[i][1];
      var raw = matrix[r][c];
      if (raw === null || raw === undefined) {
        bits[i] = null;
      } else {
        var maskBit = mtx.MASKS[mask](r, c) ? 1 : 0;
        bits[i] = raw ^ maskBit;
      }
    }
    bits = bits.slice(0, expectedDataBits);

    // Group into codeword bytes; a byte with ANY unknown bit becomes an erasure.
    var totalCodewords = info.totalData + info.ecPerBlock * (info.g1Blocks + info.g2Blocks);
    var codewords = new Array(totalCodewords).fill(0);
    var erasedFlags = new Array(totalCodewords).fill(false);
    for (var byteIdx = 0; byteIdx < totalCodewords; byteIdx++) {
      var val = 0,
        unknown = false;
      for (var b = 0; b < 8; b++) {
        var bit = bits[byteIdx * 8 + b];
        if (bit === null || bit === undefined) {
          unknown = true;
          bit = 0;
        }
        val = (val << 1) | bit;
      }
      codewords[byteIdx] = val;
      erasedFlags[byteIdx] = unknown;
    }

    // De-interleave into blocks (mirrors the encoder's interleaving exactly).
    var blocks = [];
    for (var g1 = 0; g1 < info.g1Blocks; g1++) blocks.push({ data: [], ec: [], erasures: [] });
    for (var g2 = 0; g2 < info.g2Blocks; g2++) blocks.push({ data: [], ec: [], erasures: [] });
    var numBlocks = blocks.length;
    var maxDataLen = Math.max(info.g1Data, info.g2Data || 0);
    var cwIdx = 0;
    for (var col = 0; col < maxDataLen; col++) {
      for (var bIdx = 0; bIdx < numBlocks; bIdx++) {
        var blockDataLen = bIdx < info.g1Blocks ? info.g1Data : info.g2Data;
        if (col < blockDataLen) {
          blocks[bIdx].data.push(codewords[cwIdx]);
          if (erasedFlags[cwIdx]) blocks[bIdx].erasures.push(blocks[bIdx].data.length - 1);
          cwIdx++;
        }
      }
    }
    for (var ecCol = 0; ecCol < info.ecPerBlock; ecCol++) {
      for (var bIdx2 = 0; bIdx2 < numBlocks; bIdx2++) {
        blocks[bIdx2].ec.push(codewords[cwIdx]);
        if (erasedFlags[cwIdx]) blocks[bIdx2].erasures.push(blocks[bIdx2].data.length + blocks[bIdx2].ec.length - 1);
        cwIdx++;
      }
    }

    // RS-decode each block (data+ec combined, with erasure positions).
    var allDataCodewords = [];
    var blockReports = [];
    var allBlocksOk = true;
    var totalErasuresFixed = 0,
      totalErrorsFixed = 0;
    for (var bi = 0; bi < blocks.length; bi++) {
      var blk = blocks[bi];
      var combined = blk.data.concat(blk.ec);
      var result = rs.decode(combined, info.ecPerBlock, blk.erasures);
      if (result.ok) {
        allDataCodewords = allDataCodewords.concat(result.codewords.slice(0, blk.data.length));
        totalErasuresFixed += result.erasuresCorrected;
        totalErrorsFixed += result.errorsCorrected;
        blockReports.push({ ok: true, erasures: result.erasuresCorrected, errors: result.errorsCorrected });
      } else {
        // Best effort: fall back to the raw (possibly still-damaged) data bytes for this block.
        allDataCodewords = allDataCodewords.concat(blk.data);
        allBlocksOk = false;
        blockReports.push({ ok: false, reason: result.reason, erasureCount: blk.erasures.length });
      }
    }

    var parsed = parseSegments(allDataCodewords, version);

    return {
      ok: true,
      fullyRecovered: allBlocksOk,
      version: version,
      ecLevel: ecLevel,
      mask: mask,
      formatBitErrors: fmt.bitErrors,
      erasuresCorrected: totalErasuresFixed,
      errorsCorrected: totalErrorsFixed,
      blockReports: blockReports,
      text: parsed.text,
      segments: parsed.segments,
      fullyParsed: parsed.fullyParsed,
    };
  }

  function parseSegments(dataCodewords, version) {
    var bits = [];
    for (var i = 0; i < dataCodewords.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((dataCodewords[i] >> b) & 1);
    }
    var pos = 0;
    function read(len) {
      var v = 0;
      for (var i = 0; i < len; i++) {
        v = (v << 1) | (bits[pos] || 0);
        pos++;
      }
      return v;
    }
    var segments = [];
    var text = "";
    var fullyParsed = true;
    var guard = 0;
    while (pos + 4 <= bits.length && guard < 64) {
      guard++;
      var modeBits = read(4);
      if (modeBits === 0) break; // terminator
      if (modeBits === tables.MODE_INDICATOR.numeric) {
        var ccBits = tables.charCountBits("numeric", version);
        var count = read(ccBits);
        var s = "";
        for (var n = 0; n < count; n += 3) {
          var groupLen = Math.min(3, count - n);
          var bitsLen = groupLen === 3 ? 10 : groupLen === 2 ? 7 : 4;
          var val = read(bitsLen);
          s += groupLen === 3 ? String(val).padStart(3, "0") : String(val);
        }
        segments.push({ mode: "numeric", text: s });
        text += s;
      } else if (modeBits === tables.MODE_INDICATOR.alphanumeric) {
        var ccBits2 = tables.charCountBits("alphanumeric", version);
        var count2 = read(ccBits2);
        var s2 = "";
        for (var m = 0; m < count2; m += 2) {
          if (count2 - m >= 2) {
            var v2 = read(11);
            s2 += tables.ALPHANUMERIC_CHARS[Math.floor(v2 / 45)] + tables.ALPHANUMERIC_CHARS[v2 % 45];
          } else {
            var v3 = read(6);
            s2 += tables.ALPHANUMERIC_CHARS[v3];
          }
        }
        segments.push({ mode: "alphanumeric", text: s2 });
        text += s2;
      } else if (modeBits === tables.MODE_INDICATOR.byte) {
        var ccBits3 = tables.charCountBits("byte", version);
        var count3 = read(ccBits3);
        var byteArr = [];
        for (var k = 0; k < count3; k++) byteArr.push(read(8));
        var decodedStr = utf8Decode(byteArr);
        segments.push({ mode: "byte", text: decodedStr, bytes: byteArr });
        text += decodedStr;
      } else {
        // ECI / Kanji / unsupported mode indicator encountered -- stop cleanly rather than guess.
        fullyParsed = false;
        break;
      }
      if (pos >= bits.length) break;
    }
    return { text: text, segments: segments, fullyParsed: fullyParsed };
  }

  function utf8Decode(bytes) {
    // Damaged/unrecovered blocks can leave genuinely invalid UTF-8 behind (e.g. an
    // out-of-range code point) -- fall back to a replacement character per bad byte
    // rather than letting the whole decode throw, so a partial result still comes back.
    var out = "";
    var i = 0;
    while (i < bytes.length) {
      var b0 = bytes[i];
      try {
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
          i++;
        } else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
          var cp1 = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
          out += String.fromCodePoint(cp1);
          i += 2;
        } else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
          var cp2 = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
          out += String.fromCodePoint(cp2);
          i += 3;
        } else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
          var cp3 =
            ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
          out += String.fromCodePoint(cp3);
          i += 4;
        } else {
          out += "\ufffd";
          i++;
        }
      } catch (e) {
        out += "\ufffd";
        i++;
      }
    }
    return out;
  }

  root.QR = root.QR || {};
  root.QR.decoder = {
    decode: decode,
    decodeFormatInfo: decodeFormatInfo,
    decodeVersionInfo: decodeVersionInfo,
  };
})(typeof window !== "undefined" ? window : global);
