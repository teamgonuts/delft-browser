// Package the extension for a GitHub Release:  node build.mjs  ->  dist/delft-browser-<version>.zip
import fs from "node:fs";
import { execSync } from "node:child_process";
const version = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8")).version;
fs.mkdirSync("dist", { recursive: true });
const out = `dist/delft-browser-${version}.zip`;
fs.rmSync(out, { force: true });
execSync(`tar -a -cf "${out}" --exclude=_metadata -C extension .`, { stdio: "inherit" }); // bsdtar ships with Windows 10+, macOS, most Linux
console.log(`${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
