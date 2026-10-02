const { spawn } = require('node:child_process');

const shell =
  process.platform === 'win32'
    ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : null;

function run(script, input, signal) {
  if (!shell) throw new Error('Voice chat currently requires Windows speech services.');
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      error = '';
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-100000);
    });
    child.stderr.on('data', (data) => {
      error = (error + data).slice(-4000);
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(error.trim() || 'Speech service failed.')),
    );
    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.stdin.end(input || '');
  });
}

async function listen(signal) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
    '$recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    '$recognizer.SetInputToDefaultAudioDevice()',
    '$result = $recognizer.Recognize([TimeSpan]::FromSeconds(30))',
    'if ($result) { [Console]::Out.Write($result.Text) }',
    '$recognizer.Dispose()',
  ].join('; ');
  const transcript = await run(script, '', signal);
  if (!transcript)
    throw new Error(
      'No speech was heard. Try again and check microphone access in Windows settings.',
    );
  return transcript;
}

async function speak(text, signal) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000)
    throw new Error('Nothing to speak, or response is too long.');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$speaker.Speak([Console]::In.ReadToEnd())',
    '$speaker.Dispose()',
  ].join('; ');
  await run(script, text, signal);
}

module.exports = { listen, speak };
