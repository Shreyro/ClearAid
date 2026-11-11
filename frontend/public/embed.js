/*
 * ClearAid embed helper (optional).
 *
 * A ClearAid embed is a plain <iframe>. An iframe can't grow with its content
 * by itself, so the embed tells this page how tall it is and this script sets
 * the frame's height to match:
 *
 *   <iframe data-clearaid-embed src="https://your-clearaid/embed/KEY" ...></iframe>
 *   <script async src="https://your-clearaid/embed.js"></script>
 *
 * It reads nothing from the page it runs on and sends nothing anywhere. It only
 * listens for a height from frames that it can see were loaded from the same
 * ClearAid site as this script.
 */
(function () {
  "use strict";
  if (window.__clearaidEmbed) return;
  window.__clearaidEmbed = true;

  var script = document.currentScript;
  if (!script || !script.src) return;
  var origin = new URL(script.src).origin;

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (event.origin !== origin || !msg || msg.type !== "clearaid:embed:height") return;
    var height = Math.round(Number(msg.height));
    if (!(height >= 40 && height <= 20000)) return;
    var frames = document.querySelectorAll("iframe[data-clearaid-embed]");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === event.source) frames[i].style.height = height + "px";
    }
  });
})();
