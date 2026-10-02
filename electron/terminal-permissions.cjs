const { stripVTControlCharacters } = require('node:util');

function selectCodexFullAccess(proc) {
  return new Promise((resolve, reject) => {
    let stage = 'menu';
    let output = '';
    let done = false;
    let enterTimer;
    const timeout = setTimeout(() => finish(new Error('Codex did not confirm Full access. Use the CLI menu to check its current setting.')), 12000);
    const subscription = proc.onData((data) => {
      if (done) return;
      output = (output + stripVTControlCharacters(data)).slice(-12000);
      if (
        stage === 'menu' &&
        /Update Model Permissions/.test(output) &&
        /FullAccess\(current\)/.test(output.replace(/\s+/g, ''))
      ) {
        proc.write('\x1b');
        finish();
      } else if (stage === 'menu' && /Update Model Permissions/.test(output) && /Full Access/.test(output)) {
        stage = 'selection';
        output = '';
        proc.write('\x1b[F'); // End selects the last entry, Full Access.
      } else if (stage === 'selection' && /[›>]\s*4\.\s*Full Access/.test(output)) {
        stage = 'confirmation';
        output = '';
        proc.write('\r');
      } else if (stage === 'confirmation' && /Enable full access\?/.test(output)) {
        stage = 'result';
        output = '';
        proc.write('\r'); // The confirmation screen defaults to "Yes, continue anyway".
      } else if (
        (stage === 'confirmation' || stage === 'result') &&
        /Permissionselectionrequested:FullAccess/.test(output.replace(/\s+/g, ''))
      ) {
        finish();
      }
    });
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearTimeout(enterTimer);
      subscription.dispose();
      if (error) reject(error);
      else resolve();
    }
    proc.write('/permissions');
    enterTimer = setTimeout(() => {
      if (!done) proc.write('\r');
    }, 250);
  });
}

module.exports = { selectCodexFullAccess };
