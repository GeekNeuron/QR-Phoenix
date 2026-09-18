/**
 * QR Phoenix - core/encoder.js
 * -----------------------------------------------------------------------
 * Turns a text string into a complete QR module matrix (0/1 grid),
 * choosing the smallest version that fits, picking the best data mask
 * by the standard penalty rules, and protecting the payload with
 * Reed-Solomon error-correction codewords.
 *
 * This lives in this project mainly so the "damage simulator" can
 * generate a fresh, known-correct QR code to scratch up and then
 * recover -- a self-contained demo of the whole pipeline that doesn't
 * need an external QR image at all.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var tables = root.QR.tables;
  var bch = root.QR.bch;
  var mtx = root.QR.matrix;
  var rs = root.QR.rs;

  var REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3];

  function isNumeric(str) {
    return /^[0-9]*$/.test(str);
  }
  function isAlphanumeric(str) {
    for (var i = 0; i < str.length; i++) {
      if (tables.ALPHANUMERIC_LOOKUP[str[i]] === undefined) return false;
    }
    return true;
  }

  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.codePointAt(i);
      if (code > 0xffff) i++; // consumed a surrogate pair
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return bytes;
  }

  function chooseMode(str) {
    if (isNumeric(str)) return "numeric";
    if (isAlphanumeric(str)) return "alphanumeric";
    return "byte";
  }

  var BitWriter = function () {
    this.bits = [];
  };
  BitWriter.prototype.push = function (value, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  };
  BitWriter.prototype.toBytes = function () {
    var bytes = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      bytes.push(b);
    }
    return bytes;
  };

  function encodeSegment(writer, mode, str, version) {
    writer.push(tables.MODE_INDICATOR[mode], 4);
    var ccBits = tables.charCountBits(mode, version);
    if (mode === "numeric") {
      writer.push(str.length, ccBits);
      for (var i = 0; i < str.length; i += 3) {
        var chunk = str.substr(i, 3);
        var bits = chunk.length === 3 ? 10 : chunk.length === 2 ? 7 : 4;
        writer.push(parseInt(chunk, 10), bits);
      }
    } else if (mode === "alphanumeric") {
      writer.push(str.length, ccBits);
      for (var j = 0; j < str.length; j += 2) {
        if (j + 1 < str.length) {
          var v = tables.ALPHANUMERIC_LOOKUP[str[j]] * 45 + tables.ALPHANUMERIC_LOOKUP[str[j + 1]];
          writer.push(v, 11);
        } else {
          writer.push(tables.ALPHANUMERIC_LOOKUP[str[j]], 6);
        }
      }
    } else {
      var bytes = utf8Bytes(str);
      writer.push(bytes.length, ccBits);
      for (var k = 0; k < bytes.length; k++) writer.push(bytes[k], 8);
    }
  }

  function bitLengthForSegment(mode, str, version) {
    var ccBits = tables.charCountBits(mode, version);
    var dataBits;
    if (mode === "numeric") {
      dataBits = Math.floor(str.length / 3) * 10 + [0, 4, 7][str.length % 3];
    } else if (mode === "alphanumeric") {
      dataBits = Math.floor(str.length / 2) * 11 + (str.length % 2) * 6;
    } else {
      dataBits = utf8Bytes(str).length * 8;
    }
    return 4 + ccBits + dataBits;
  }

  function findSmallestVersion(str, mode, ecLevel) {
    for (var v = 1; v <= tables.MAX_VERSION; v++) {
      var neededBits = bitLengthForSegment(mode, str, v);
      var neededBytes = Math.ceil(neededBits / 8);
      var cap = tables.blockInfo(v, ecLevel).totalData;
      if (neededBytes <= cap) return v;
    }
    return -1; // too big for our supported range
  }

  /**
   * Encode text into a QR matrix.
   * @param text the payload string
   * @param ecLevel one of tables.EC.{L,M,Q,H}
   * @param forceVersion optional explicit version to use (must fit)
   * @returns { matrix, version, ecLevel, mask, size } or throws if it doesn't fit
   */
  function encode(text, ecLevel, forceVersion) {
    var mode = chooseMode(text);
    var version = forceVersion || findSmallestVersion(text, mode, ecLevel);
    if (version === -1) {
      throw new Error("متن برای بازه نسخه‌های پشتیبانی‌شده (۱ تا ۲۰) خیلی بزرگ است.");
    }

    var info = tables.blockInfo(version, ecLevel);
    var capacityBits = info.totalData * 8;

    var writer = new BitWriter();
    encodeSegment(writer, mode, text, version);
    // Terminator (up to 4 bits of 0), then pad to a byte boundary.
    var remaining = capacityBits - writer.bits.length;
    writer.push(0, Math.min(4, Math.max(0, remaining)));
    while (writer.bits.length % 8 !== 0) writer.bits.push(0);

    var dataCodewords = writer.toBytes();
    var padBytes = [0xec, 0x11];
    var padIdx = 0;
    while (dataCodewords.length < info.totalData) {
      dataCodewords.push(padBytes[padIdx % 2]);
      padIdx++;
    }

    // Split into blocks, RS-encode each.
    var blocks = [];
    var pos = 0;
    for (var g1 = 0; g1 < info.g1Blocks; g1++) {
      var d1 = dataCodewords.slice(pos, pos + info.g1Data);
      pos += info.g1Data;
      blocks.push({ data: d1, ec: rs.encode(d1, info.ecPerBlock) });
    }
    for (var g2 = 0; g2 < info.g2Blocks; g2++) {
      var d2 = dataCodewords.slice(pos, pos + info.g2Data);
      pos += info.g2Data;
      blocks.push({ data: d2, ec: rs.encode(d2, info.ecPerBlock) });
    }

    // Interleave data codewords, then EC codewords.
    var finalBytes = [];
    var maxDataLen = Math.max(info.g1Data, info.g2Data || 0);
    for (var i = 0; i < maxDataLen; i++) {
      for (var b = 0; b < blocks.length; b++) {
        if (i < blocks[b].data.length) finalBytes.push(blocks[b].data[i]);
      }
    }
    for (var j = 0; j < info.ecPerBlock; j++) {
      for (var b2 = 0; b2 < blocks.length; b2++) {
        finalBytes.push(blocks[b2].ec[j]);
      }
    }

    var finalBits = [];
    for (var fi = 0; fi < finalBytes.length; fi++) {
      for (var bit = 7; bit >= 0; bit--) finalBits.push((finalBytes[fi] >> bit) & 1);
    }
    var remainderCount = REMAINDER_BITS[version] || 0;
    for (var r = 0; r < remainderCount; r++) finalBits.push(0);

    // Build the matrix skeleton and place data bits along the zigzag path.
    var skeleton = mtx.buildSkeleton(version);
    var path = mtx.dataPath(skeleton.size, skeleton.reserved);
    if (path.length !== finalBits.length) {
      throw new Error("عدم تطابق داخلی در تعداد بیت‌ها (نسخه " + version + ")");
    }

    // Try all 8 masks, keep the lowest-penalty one.
    var bestMask = 0,
      bestScore = Infinity,
      bestMatrix = null;
    for (var m = 0; m < 8; m++) {
      var candidate = skeleton.matrix.map(function (row) {
        return row.slice();
      });
      for (var pi = 0; pi < path.length; pi++) {
        var rr = path[pi][0],
          cc = path[pi][1];
        var bitVal = finalBits[pi];
        var maskBit = mtx.MASKS[m](rr, cc) ? 1 : 0;
        candidate[rr][cc] = bitVal ^ maskBit;
      }
      var specEc = bch.ecIndexToSpecBits[ecLevel];
      mtx.writeFormatInfo(candidate, skeleton.size, bch.encodeFormat(specEc, m));
      if (version >= 7) mtx.writeVersionInfo(candidate, skeleton.size, bch.encodeVersion(version));
      var score = mtx.penaltyScore(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestMask = m;
        bestMatrix = candidate;
      }
    }

    return {
      matrix: bestMatrix,
      version: version,
      ecLevel: ecLevel,
      mask: bestMask,
      size: skeleton.size,
      mode: mode,
    };
  }

  root.QR = root.QR || {};
  root.QR.encoder = {
    encode: encode,
    chooseMode: chooseMode,
    findSmallestVersion: findSmallestVersion,
  };
})(typeof window !== "undefined" ? window : global);
