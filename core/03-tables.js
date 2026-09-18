/**
 * QR Phoenix - core/tables.js
 * -----------------------------------------------------------------------
 * Static structural tables from ISO/IEC 18004. Supports versions 1-20
 * (21x21 up to 97x97 modules), which comfortably covers URLs, vCards,
 * Wi-Fi credentials, and any typical short-to-medium text payload.
 * -----------------------------------------------------------------------
 */
(function (root) {
  "use strict";

  var EC = { L: 0, M: 1, Q: 2, H: 3 };
  var EC_NAMES = ["L", "M", "Q", "H"];

  // [version][ecLevel] = [totalData, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
  var BLOCK_TABLE = {
    1: { L: [19, 7, 1, 19, 0, 0], M: [16, 10, 1, 16, 0, 0], Q: [13, 13, 1, 13, 0, 0], H: [9, 17, 1, 9, 0, 0] },
    2: { L: [34, 10, 1, 34, 0, 0], M: [28, 16, 1, 28, 0, 0], Q: [22, 22, 1, 22, 0, 0], H: [16, 28, 1, 16, 0, 0] },
    3: { L: [55, 15, 1, 55, 0, 0], M: [44, 26, 1, 44, 0, 0], Q: [34, 18, 2, 17, 0, 0], H: [26, 22, 2, 13, 0, 0] },
    4: { L: [80, 20, 1, 80, 0, 0], M: [64, 18, 2, 32, 0, 0], Q: [48, 26, 2, 24, 0, 0], H: [36, 16, 4, 9, 0, 0] },
    5: { L: [108, 26, 1, 108, 0, 0], M: [86, 24, 2, 43, 0, 0], Q: [62, 18, 2, 15, 2, 16], H: [46, 22, 2, 11, 2, 12] },
    6: { L: [136, 18, 2, 68, 0, 0], M: [108, 16, 4, 27, 0, 0], Q: [76, 24, 4, 19, 0, 0], H: [60, 28, 4, 15, 0, 0] },
    7: { L: [156, 20, 2, 78, 0, 0], M: [124, 18, 4, 31, 0, 0], Q: [88, 18, 2, 14, 4, 15], H: [66, 26, 4, 13, 1, 14] },
    8: { L: [194, 24, 2, 97, 0, 0], M: [154, 22, 2, 38, 2, 39], Q: [110, 22, 4, 18, 2, 19], H: [86, 26, 4, 14, 2, 15] },
    9: { L: [232, 30, 2, 116, 0, 0], M: [182, 22, 3, 36, 2, 37], Q: [132, 20, 4, 16, 4, 17], H: [100, 24, 4, 12, 4, 13] },
    10: { L: [274, 18, 2, 68, 2, 69], M: [216, 26, 4, 43, 1, 44], Q: [154, 24, 6, 19, 2, 20], H: [122, 28, 6, 15, 2, 16] },
    11: { L: [324, 20, 4, 81, 0, 0], M: [254, 30, 1, 50, 4, 51], Q: [180, 28, 4, 22, 4, 23], H: [140, 24, 3, 12, 8, 13] },
    12: { L: [370, 24, 2, 92, 2, 93], M: [290, 22, 6, 36, 2, 37], Q: [206, 26, 4, 20, 6, 21], H: [158, 28, 7, 14, 4, 15] },
    13: { L: [428, 26, 4, 107, 0, 0], M: [334, 22, 8, 37, 1, 38], Q: [244, 24, 8, 20, 4, 21], H: [180, 22, 12, 11, 4, 12] },
    14: { L: [461, 30, 3, 115, 1, 116], M: [365, 24, 4, 40, 5, 41], Q: [261, 20, 11, 16, 5, 17], H: [197, 24, 11, 12, 5, 13] },
    15: { L: [523, 22, 5, 87, 1, 88], M: [415, 24, 5, 41, 5, 42], Q: [295, 30, 5, 24, 7, 25], H: [223, 24, 11, 12, 7, 13] },
    16: { L: [589, 24, 5, 98, 1, 99], M: [453, 28, 7, 45, 3, 46], Q: [325, 24, 15, 19, 2, 20], H: [253, 30, 3, 15, 13, 16] },
    17: { L: [647, 28, 1, 107, 5, 108], M: [507, 28, 10, 46, 1, 47], Q: [367, 28, 1, 22, 15, 23], H: [283, 28, 2, 14, 17, 15] },
    18: { L: [721, 30, 5, 120, 1, 121], M: [563, 26, 9, 43, 4, 44], Q: [397, 28, 17, 22, 1, 23], H: [313, 28, 2, 14, 19, 15] },
    19: { L: [795, 28, 3, 113, 4, 114], M: [627, 26, 3, 44, 11, 45], Q: [445, 26, 17, 21, 4, 22], H: [341, 26, 9, 13, 16, 14] },
    20: { L: [861, 28, 3, 107, 5, 108], M: [669, 26, 3, 41, 13, 42], Q: [485, 30, 15, 24, 5, 25], H: [385, 28, 15, 15, 10, 16] },
  };

  // Alignment pattern center coordinates by version (empty for version 1, which has none).
  var ALIGNMENT = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
    11: [6, 30, 54],
    12: [6, 32, 58],
    13: [6, 34, 62],
    14: [6, 26, 46, 66],
    15: [6, 26, 48, 70],
    16: [6, 26, 50, 74],
    17: [6, 30, 54, 78],
    18: [6, 30, 56, 82],
    19: [6, 30, 58, 86],
    20: [6, 34, 62, 90],
  };

  // Character-count-indicator bit widths, by mode, for version ranges 1-9, 10-26, 27-40.
  var CHAR_COUNT_BITS = {
    numeric: [10, 12, 14],
    alphanumeric: [9, 11, 13],
    byte: [8, 16, 16],
  };

  function charCountBits(mode, version) {
    var idx = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    return CHAR_COUNT_BITS[mode][idx];
  }

  var MODE_INDICATOR = { numeric: 0x1, alphanumeric: 0x2, byte: 0x4, eci: 0x7, kanji: 0x8, terminator: 0x0 };

  var ALPHANUMERIC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  var ALPHANUMERIC_LOOKUP = {};
  for (var ai = 0; ai < ALPHANUMERIC_CHARS.length; ai++) ALPHANUMERIC_LOOKUP[ALPHANUMERIC_CHARS[ai]] = ai;

  function moduleCount(version) {
    return version * 4 + 17;
  }

  function blockInfo(version, ecLevel) {
    var row = BLOCK_TABLE[version][EC_NAMES[ecLevel]];
    return {
      totalData: row[0],
      ecPerBlock: row[1],
      g1Blocks: row[2],
      g1Data: row[3],
      g2Blocks: row[4],
      g2Data: row[5],
    };
  }

  root.QR = root.QR || {};
  root.QR.tables = {
    EC: EC,
    EC_NAMES: EC_NAMES,
    MODE_INDICATOR: MODE_INDICATOR,
    ALPHANUMERIC_CHARS: ALPHANUMERIC_CHARS,
    ALPHANUMERIC_LOOKUP: ALPHANUMERIC_LOOKUP,
    MAX_VERSION: 20,
    moduleCount: moduleCount,
    blockInfo: blockInfo,
    alignmentPositions: function (version) {
      return ALIGNMENT[version] || [];
    },
    charCountBits: charCountBits,
  };
})(typeof window !== "undefined" ? window : global);
