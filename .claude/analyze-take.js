// Dev-only: quick health report for an exported AVCP telemetry JSON.
var fs = require("fs");
var d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
var t = d.time, n = t.length;
var dts = []; for (var i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
dts.sort(function (a, b) { return a - b; });
function pct(p) { return dts[Math.floor(p * (dts.length - 1))]; }
console.log("name:", d.meta.name, "| vehicle:", d.meta.vehicle);
console.log("rate set:", d.meta.rate, "Hz | duration:", d.meta.duration.toFixed(2), "s | samples:", n);
console.log("effective rate:", (n / d.meta.duration).toFixed(1), "Hz");
console.log("dt p50/p95/max:", pct(.5).toFixed(3), pct(.95).toFixed(3), dts[dts.length - 1].toFixed(3), "s");
console.log("markers:", JSON.stringify(d.markers));
console.log("channels:", d.channels.length);
d.channels.forEach(function (c) {
  var mn = Infinity, mx = -Infinity, nan = 0;
  c.data.forEach(function (v) { if (v == null || isNaN(v)) { nan++; return; } if (v < mn) mn = v; if (v > mx) mx = v; });
  console.log(c.id + ": [" + (mn === Infinity ? "-" : mn.toFixed(2)) + " .. " +
    (mx === -Infinity ? "-" : mx.toFixed(2)) + "]" + (nan ? "  NaN:" + nan : ""));
});
