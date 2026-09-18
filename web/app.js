/**
 * QR Phoenix - web/app.js
 * -----------------------------------------------------------------------
 * UI glue only -- all the actual QR math lives in /core. This file:
 *   1. Renders a generated QR to a canvas and lets the user "damage" it
 *      with a brush (marking exact erased modules -- the fast path).
 *   2. Handles a real uploaded photo: binarize -> locate finders ->
 *      homography -> sample modules -> optional manual damage marking
 *      -> decode.
 *   3. Renders the recovered result nicely.
 * -----------------------------------------------------------------------
 */
(function () {
  "use strict";

  var QR = window.QR;

  // ---------------------------------------------------------------- Tabs
  var tabButtons = document.querySelectorAll(".tab-btn");
  var panels = document.querySelectorAll(".tab-panel");
  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabButtons.forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      panels.forEach(function (p) { p.classList.remove("active"); });
      document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
    });
  });

  // ============================================================
  // TAB 1: GENERATE + DAMAGE SIMULATOR
  // ============================================================
  var genState = {
    ecLevel: QR.tables.EC.H,
    encoded: null,
    cellPx: 10,
    quiet: 4,
    damage: null, // size x size boolean grid
    drawing: false,
    brushSize: 18,
  };

  var ecGroup = document.getElementById("ec-level-group");
  ecGroup.querySelectorAll("button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      ecGroup.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      genState.ecLevel = parseInt(btn.dataset.ec, 10);
    });
  });

  var brushSizeInput = document.getElementById("brush-size");
  brushSizeInput.addEventListener("input", function () {
    genState.brushSize = parseInt(brushSizeInput.value, 10);
  });

  document.getElementById("btn-generate").addEventListener("click", function () {
    var text = document.getElementById("gen-text").value.trim();
    if (!text) {
      alert("لطفاً یک متن یا لینک وارد کنید.");
      return;
    }
    var resultCard = document.getElementById("gen-result");
    resultCard.hidden = true;
    try {
      var enc = QR.encoder.encode(text, genState.ecLevel);
      genState.encoded = enc;
      genState.sourceText = text;
      genState.damage = QR.matrix.makeGrid(enc.size, false);
      genState.cellPx = Math.max(4, Math.min(14, Math.floor(480 / (enc.size + 8))));

      var canvas = document.getElementById("qr-canvas");
      var total = (enc.size + genState.quiet * 2) * genState.cellPx;
      canvas.width = total;
      canvas.height = total;
      renderGenCanvas();
      document.getElementById("damage-card").hidden = false;
      updateDamageStat();
    } catch (e) {
      alert(e.message || "خطا در ساخت کیوآرکد.");
    }
  });

  function renderGenCanvas() {
    var canvas = document.getElementById("qr-canvas");
    var ctx = canvas.getContext("2d");
    var enc = genState.encoded;
    var cell = genState.cellPx,
      q = genState.quiet;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var r = 0; r < enc.size; r++) {
      for (var c = 0; c < enc.size; c++) {
        var x = (c + q) * cell,
          y = (r + q) * cell;
        if (genState.damage[r][c]) {
          drawScratch(ctx, x, y, cell);
        } else {
          ctx.fillStyle = enc.matrix[r][c] ? "#111318" : "#ffffff";
          ctx.fillRect(x, y, cell, cell);
        }
      }
    }
  }

  function drawScratch(ctx, x, y, cell) {
    ctx.fillStyle = "#8a8f9c";
    ctx.fillRect(x, y, cell, cell);
    ctx.strokeStyle = "rgba(255,95,61,0.55)";
    ctx.lineWidth = Math.max(1, cell * 0.12);
    ctx.beginPath();
    ctx.moveTo(x + cell * 0.15, y + cell * 0.15);
    ctx.lineTo(x + cell * 0.85, y + cell * 0.85);
    ctx.moveTo(x + cell * 0.85, y + cell * 0.15);
    ctx.lineTo(x + cell * 0.15, y + cell * 0.85);
    ctx.stroke();
  }

  function markDamageAt(canvasX, canvasY) {
    var enc = genState.encoded;
    var cell = genState.cellPx,
      q = genState.quiet;
    var radiusModules = genState.brushSize / cell;
    var centerCol = canvasX / cell - q;
    var centerRow = canvasY / cell - q;
    var minR = Math.max(0, Math.floor(centerRow - radiusModules));
    var maxR = Math.min(enc.size - 1, Math.ceil(centerRow + radiusModules));
    var minC = Math.max(0, Math.floor(centerCol - radiusModules));
    var maxC = Math.min(enc.size - 1, Math.ceil(centerCol + radiusModules));
    var changed = false;
    for (var r = minR; r <= maxR; r++) {
      for (var c = minC; c <= maxC; c++) {
        var dr = r + 0.5 - centerRow,
          dc = c + 0.5 - centerCol;
        if (Math.sqrt(dr * dr + dc * dc) <= radiusModules) {
          if (!genState.damage[r][c]) changed = true;
          genState.damage[r][c] = true;
        }
      }
    }
    if (changed) {
      renderGenCanvas();
      updateDamageStat();
    }
  }

  function updateDamageStat() {
    var enc = genState.encoded;
    var skeleton = QR.matrix.buildSkeleton(enc.version);
    var totalData = 0,
      damagedData = 0;
    for (var r = 0; r < enc.size; r++) {
      for (var c = 0; c < enc.size; c++) {
        if (!skeleton.reserved[r][c]) {
          totalData++;
          if (genState.damage[r][c]) damagedData++;
        }
      }
    }
    var pct = totalData ? Math.round((damagedData / totalData) * 100) : 0;
    document.getElementById("damage-percent").textContent = toPersianDigits(pct) + "٪";
    document.getElementById("damage-bar-fill").style.width = pct + "%";
  }

  (function wireCanvasBrush() {
    var canvas = document.getElementById("qr-canvas");
    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width,
        scaleY = canvas.height / rect.height;
      var clientX = e.clientX !== undefined ? e.clientX : e.touches[0].clientX;
      var clientY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }
    canvas.addEventListener("pointerdown", function (e) {
      if (!genState.encoded) return;
      genState.drawing = true;
      var p = pos(e);
      markDamageAt(p.x, p.y);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!genState.drawing) return;
      var p = pos(e);
      markDamageAt(p.x, p.y);
    });
    window.addEventListener("pointerup", function () { genState.drawing = false; });
  })();

  document.getElementById("btn-clear-damage").addEventListener("click", function () {
    if (!genState.encoded) return;
    genState.damage = QR.matrix.makeGrid(genState.encoded.size, false);
    renderGenCanvas();
    updateDamageStat();
  });

  document.getElementById("btn-recover").addEventListener("click", function () {
    if (!genState.encoded) return;
    var enc = genState.encoded;
    var damaged = enc.matrix.map(function (row) { return row.slice(); });
    for (var r = 0; r < enc.size; r++) {
      for (var c = 0; c < enc.size; c++) {
        if (genState.damage[r][c]) damaged[r][c] = null;
      }
    }
    var dec = QR.decoder.decode(damaged);
    renderResult(document.getElementById("gen-result"), dec, genState.sourceText);
  });

  // ============================================================
  // TAB 2: UPLOAD REAL IMAGE
  // ============================================================
  var uploadState = {
    img: null,
    canvas: document.getElementById("upload-canvas"),
    damageMask: null, // same-size offscreen canvas; painted strokes mark forced-erasure
    brushSize: 24,
    drawing: false,
  };

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("file-input");
  dropzone.addEventListener("click", function () { fileInput.click(); });
  ["dragover", "dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.toggle("drag-over", evt === "dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer.files[0];
    if (file) loadImageFile(file);
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files[0]) loadImageFile(fileInput.files[0]);
  });

  function loadImageFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        uploadState.img = img;
        var maxDim = 900;
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale),
          h = Math.round(img.height * scale);
        var canvas = uploadState.canvas;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        uploadState.damageMask = document.createElement("canvas");
        uploadState.damageMask.width = w;
        uploadState.damageMask.height = h;

        document.getElementById("upload-canvas-card").hidden = false;
        document.getElementById("upload-result").hidden = true;
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  document.getElementById("upload-brush-size").addEventListener("input", function (e) {
    uploadState.brushSize = parseInt(e.target.value, 10);
  });

  (function wireUploadBrush() {
    var canvas = uploadState.canvas;
    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width,
        scaleY = canvas.height / rect.height;
      var clientX = e.clientX !== undefined ? e.clientX : e.touches[0].clientX;
      var clientY = e.clientY !== undefined ? e.clientY : e.touches[0].clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    }
    function paint(x, y) {
      var maskCtx = uploadState.damageMask.getContext("2d");
      maskCtx.fillStyle = "#fff";
      maskCtx.beginPath();
      maskCtx.arc(x, y, uploadState.brushSize / 2, 0, Math.PI * 2);
      maskCtx.fill();
      redrawUploadCanvas();
    }
    canvas.addEventListener("pointerdown", function (e) {
      if (!uploadState.img) return;
      uploadState.drawing = true;
      var p = pos(e);
      paint(p.x, p.y);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!uploadState.drawing) return;
      var p = pos(e);
      paint(p.x, p.y);
    });
    window.addEventListener("pointerup", function () { uploadState.drawing = false; });
  })();

  function redrawUploadCanvas() {
    var canvas = uploadState.canvas;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(uploadState.img, 0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.drawImage(uploadState.damageMask, 0, 0);
    ctx.restore();
  }

  document.getElementById("btn-clear-upload-damage").addEventListener("click", function () {
    if (!uploadState.damageMask) return;
    var mctx = uploadState.damageMask.getContext("2d");
    mctx.clearRect(0, 0, uploadState.damageMask.width, uploadState.damageMask.height);
    redrawUploadCanvas();
  });

  document.getElementById("btn-decode-upload").addEventListener("click", function () {
    var btn = document.getElementById("btn-decode-upload");
    var originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> در حال تحلیل...';

    setTimeout(function () {
      try {
        var canvas = uploadState.canvas;
        var ctx = canvas.getContext("2d");
        var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        var maskCtx = uploadState.damageMask.getContext("2d");
        var maskData = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
        function isForcedErased(x, y) {
          var xi = Math.round(x),
            yi = Math.round(y);
          if (xi < 0 || yi < 0 || xi >= canvas.width || yi >= canvas.height) return false;
          var idx = (yi * canvas.width + xi) * 4 + 3;
          return maskData.data[idx] > 40;
        }

        var result = QR.imaging.detectAndSample(imageData, { isForcedErased: isForcedErased });
        var resultCard = document.getElementById("upload-result");
        if (!result.ok) {
          resultCard.hidden = false;
          resultCard.innerHTML =
            '<div class="result-head"><div class="result-badge fail">❌</div>' +
            '<div><div class="result-title">الگوهای راهنما پیدا نشدند</div>' +
            '<div class="result-sub">' +
            reasonToFarsi(result.reason) +
            "</div></div></div>" +
            '<p class="hint">پیشنهاد: تصویر واضح‌تر، روبه‌روتر و با نور یکنواخت‌تر امتحان کنید، یا کیوآرکد را بزرگ‌تر در قاب بگیرید.</p>';
          return;
        }
        var dec = QR.decoder.decode(result.matrix);
        renderResult(resultCard, dec, null);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      }
    }, 30);
  });

  function reasonToFarsi(reason) {
    var map = {
      "finder-patterns-not-found": "سه الگوی گوشهٔ کیوآرکد (مربع‌های تودرتو) به‌وضوح در تصویر شناسایی نشد.",
      "finder-classification-failed": "الگوهای گوشه پیدا شدند، اما آرایش آن‌ها قابل تشخیص نبود.",
      "homography-failed": "محاسبهٔ هندسهٔ تصویر با خطا مواجه شد.",
    };
    return map[reason] || "علت: " + reason;
  }

  // ============================================================
  // Shared result renderer
  // ============================================================
  function renderResult(card, dec, expectedText) {
    card.hidden = false;
    if (!dec.ok) {
      card.innerHTML =
        '<div class="result-head"><div class="result-badge fail">❌</div>' +
        '<div><div class="result-title">بازیابی ناموفق بود</div>' +
        '<div class="result-sub">' +
        (dec.reason || "دلیل نامشخص") +
        "</div></div></div>" +
        '<p class="hint">میزان آسیب از ظرفیت تصحیح این سطح (EC) فراتر رفته است. سطح تصحیح بالاتری (Q یا H) امتحان کنید یا آسیب کمتری وارد کنید.</p>';
      return;
    }

    var statusIcon = dec.fullyRecovered ? "✅" : "🟡";
    var statusClass = dec.fullyRecovered ? "ok" : "partial";
    var statusTitle = dec.fullyRecovered ? "بازیابی کامل و موفق!" : "بازیابی جزئی — بخشی قابل خواندن است";

    var html = "";
    html += '<div class="result-head">';
    html += '<div class="result-badge ' + statusClass + '">' + statusIcon + "</div>";
    html += "<div><div class=\"result-title\">" + statusTitle + "</div>";
    html +=
      '<div class="result-sub">نسخه ' +
      toPersianDigits(dec.version) +
      " · سطح " +
      QR.tables.EC_NAMES[dec.ecLevel] +
      " · ماسک " +
      toPersianDigits(dec.mask) +
      "</div></div></div>";

    html +=
      '<div class="result-text-box">' +
      escapeHtml(dec.text || "(متنی استخراج نشد)") +
      '<button class="copy-btn" id="copy-btn">📋 کپی</button></div>';

    html += '<div class="stat-grid">';
    html += statBox(toPersianDigits(dec.erasuresCorrected), "خانهٔ حذف‌شده ترمیم شد");
    html += statBox(toPersianDigits(dec.errorsCorrected), "خطای ناشناخته ترمیم شد");
    html += statBox(toPersianDigits(dec.formatBitErrors), "خطای بیت در اطلاعات فرمت");
    html += statBox(dec.fullyParsed ? "بله" : "جزئی", "خوانش کامل پیام");
    html += "</div>";

    if (dec.blockReports && dec.blockReports.length > 1) {
      html += '<div class="block-report">';
      dec.blockReports.forEach(function (b, i) {
        html +=
          '<span class="block-chip ' +
          (b.ok ? "ok" : "fail") +
          '">بلوک ' +
          toPersianDigits(i + 1) +
          (b.ok ? " ✓" : " ✗") +
          "</span>";
      });
      html += "</div>";
    }

    if (expectedText !== null && expectedText !== undefined) {
      var matches = dec.text === expectedText;
      html +=
        '<p class="hint">' +
        (matches
          ? "✅ متن بازیابی‌شده دقیقاً با متن اصلی یکسان است."
          : "⚠️ متن بازیابی‌شده با متن اصلی تفاوت دارد — آسیب از ظرفیت تصحیح فراتر رفته است.") +
        "</p>";
    }

    card.innerHTML = html;
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });

    var copyBtn = document.getElementById("copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(dec.text || "").then(function () {
          copyBtn.textContent = "✅ کپی شد";
          setTimeout(function () { copyBtn.innerHTML = "📋 کپی"; }, 1500);
        });
      });
    }
  }

  function statBox(value, label) {
    return '<div class="stat-box"><b>' + value + "</b><span>" + label + "</span></div>";
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function toPersianDigits(n) {
    var map = { 0: "۰", 1: "۱", 2: "۲", 3: "۳", 4: "۴", 5: "۵", 6: "۶", 7: "۷", 8: "۸", 9: "۹" };
    return String(n).replace(/[0-9]/g, function (d) { return map[d]; });
  }
})();
