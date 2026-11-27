'use strict';
// Is OS-backed secret encryption genuinely available? On Linux without a keyring Electron falls back to the
// "basic_text" backend (a hard-coded key), which isEncryptionAvailable() still reports as available.
function usable(safeStorage) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      const b = safeStorage.getSelectedStorageBackend();
      if (b === 'basic_text' || b === 'unknown') return false;
    }
    return true;
  } catch { return false; }
}
module.exports = { usable };
