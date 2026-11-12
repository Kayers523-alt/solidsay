#!/usr/bin/env node
/* Runs every *.test.js in this folder. Exit code 1 on any failure. */
"use strict";
const fs = require("fs");
const path = require("path");
const h = require("./harness");
fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); }).sort().forEach(function (f) {
  require(path.join(__dirname, f));
});
console.log("\n" + h.results.pass + " passed, " + h.results.fail + " failed");
if (h.results.fail) { console.log(h.results.failures.map(function (f) { return " - " + f; }).join("\n")); process.exit(1); }
