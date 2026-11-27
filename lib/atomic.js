'use strict';
const fs = require('fs');

// Write to a temp file then rename, so a crash mid-write can't leave a truncated JSON file.
function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode ? { encoding: 'utf-8', mode } : 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}
module.exports = { writeFileAtomic };
