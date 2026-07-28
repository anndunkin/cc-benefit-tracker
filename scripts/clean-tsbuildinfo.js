#!/usr/bin/env node
/**
 * scripts/clean-tsbuildinfo.js
 * Cross-platform replacement for: find . -name "*.tsbuildinfo" -delete
 * Safe to run on Windows (no Unix `find` required).
 */
'use strict';
const fs   = require('fs');
const path = require('path');

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      fs.unlinkSync(full);
      console.log('deleted:', full);
    }
  }
}

walk(path.resolve(__dirname, '..'));
