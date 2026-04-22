/**
 * Resize and compress images for local (browser) storage.
 * Target ~70% dimensions + JPEG quality for smaller data URLs.
 */
(function () {
  function compressImageFile(file, options) {
    options = options || {};
    var maxSide = options.maxSide || 1200;
    var quality = options.quality != null ? options.quality : 0.72;
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || file.type.indexOf("image/") !== 0) {
        reject(new Error("Not an image"));
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        var scale = 1;
        if (w > maxSide || h > maxSide) {
          scale = maxSide / Math.max(w, h);
        }
        var cw = Math.round(w * scale);
        var ch = Math.round(h * scale);
        var canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = ch;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, cw, ch);
        try {
          var dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(dataUrl);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Load failed"));
      };
      img.src = url;
    });
  }

  window.GarudaImageUtils = { compressImageFile: compressImageFile };
})();
