/*
 * Where this demo site finds ClearAid.
 *
 * On your own computer (localhost) it uses the ClearAid you started on port 3000.
 * Anywhere else it falls back to the ClearAid address below.
 * Change HOSTED if you serve this site from another address.
 *
 * The three embeds use fixed demo keys that ClearAid creates by itself in its demo
 * data, so nothing has to be pasted here. A real NGO website just pastes the
 * <iframe> and <script> code from ClearAid (Settings > Public embeds > Get code).
 */
(function () {
  "use strict";
  var HOSTED = "https://clearaid-web.onrender.com";
  var local = ["localhost", "127.0.0.1", "[::1]", ""].indexOf(location.hostname) !== -1;
  var origin = local ? "http://localhost:3000" : HOSTED;

  document.querySelectorAll("iframe[data-clearaid-embed][data-key]").forEach(function (f) {
    f.src = origin + "/embed/" + encodeURIComponent(f.getAttribute("data-key"));
  });
  document.querySelectorAll("a[href^='" + HOSTED + "/']").forEach(function (a) {
    a.href = origin + a.getAttribute("href").slice(HOSTED.length);
  });

  // Sizes each frame to fit its content (served by ClearAid).
  var s = document.createElement("script");
  s.async = true;
  s.src = origin + "/embed.js";
  document.body.appendChild(s);
})();
