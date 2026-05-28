import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = resolve('.');
const port = Number(process.env.PORT || 8000);
const geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/';
const geminiApiKeyNames = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
];

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
]);

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function loadLocalEnv() {
  for (const name of ['.env.local', '.env']) {
    try {
      const text = await fs.readFile(resolve(root, name), 'utf8');
      text.split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1].startsWith('#') || process.env[match[1]]) return;

        let value = match[2];
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not read ${name}: ${error.message}`);
    }
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getGeminiApiKey(req) {
  const requestKey = getHeader(req, 'x-goog-api-key');
  if (requestKey) return requestKey;

  for (const name of geminiApiKeyNames) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function extractTextFromSsml(ssml) {
  return ssml
    .replace(/<mark\b[^>]*\/>/gi, ' ')
    .replace(/<break\b[^>]*\/>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function synthesizeWithWindowsVoice(text, options = {}) {
  const id = randomUUID();
  const textPath = join(tmpdir(), `talkinghead-${id}.txt`);
  const wavPath = join(tmpdir(), `talkinghead-${id}.wav`);
  const scriptPath = join(tmpdir(), `talkinghead-${id}.ps1`);
  const preferredVoice = process.env.LOCAL_TTS_VOICE || '';
  const preferredCulture = options.languageCode || '';

  const script = `
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath $args[0]
$preferredVoice = $args[2]
$preferredCulture = $args[3]
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($preferredVoice) {
  $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -eq $preferredVoice } | Select-Object -First 1
  if ($voice) {
    $speaker.SelectVoice($voice.VoiceInfo.Name)
  }
}
if (-not $voice) {
  $culturePrefix = if ($preferredCulture.Length -ge 2) { $preferredCulture.Substring(0,2).ToLowerInvariant() } else { "" }
  $voice = $speaker.GetInstalledVoices() | Where-Object {
    $_.Enabled -and
    $_.VoiceInfo.Gender -eq "Female" -and
    ($culturePrefix -eq "" -or $_.VoiceInfo.Culture.TwoLetterISOLanguageName.ToLowerInvariant() -eq $culturePrefix)
  } | Select-Object -First 1
  if (-not $voice) {
    $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Gender -eq "Female" } | Select-Object -First 1
  }
  if ($voice) {
    $speaker.SelectVoice($voice.VoiceInfo.Name)
  }
}
$speaker.SetOutputToWaveFile($args[1])
$speaker.Speak($text)
$speaker.Dispose()
`;

  await fs.writeFile(textPath, text, 'utf8');
  await fs.writeFile(scriptPath, script, 'utf8');

  await new Promise((resolvePromise, rejectPromise) => {
    const ps = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      textPath,
      wavPath,
      preferredVoice,
      preferredCulture,
    ], { windowsHide: true });

    let stderr = '';
    ps.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    ps.on('error', rejectPromise);
    ps.on('exit', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(stderr || `PowerShell exited with code ${code}`));
    });
  });

  const wav = await fs.readFile(wavPath);
  await Promise.allSettled([
    fs.unlink(textPath),
    fs.unlink(wavPath),
    fs.unlink(scriptPath),
  ]);
  return wav;
}

async function handleGoogleTts(req, res) {
  try {
    const body = JSON.parse(await readRequestBody(req));
    const ssml = body?.input?.ssml || '';
    const text = extractTextFromSsml(ssml);

    if (!text) {
      sendJson(res, 400, { error: { message: 'No text to synthesize.' } });
      return;
    }

    const wav = await synthesizeWithWindowsVoice(text, {
      languageCode: body?.voice?.languageCode || '',
    });
    sendJson(res, 200, {
      audioContent: wav.toString('base64'),
      timepoints: [],
    });
  } catch (error) {
    sendJson(res, 500, { error: { message: error.message || String(error) } });
  }
}

async function handleGeminiProxy(req, res) {
  try {
    const localUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const geminiPath = decodeURIComponent(localUrl.pathname.slice('/gemini/'.length));

    if (!/^[A-Za-z0-9._:-]+$/.test(geminiPath)) {
      sendJson(res, 400, { error: { message: 'Invalid Gemini proxy path.' } });
      return;
    }

    const apiKey = getGeminiApiKey(req);
    if (!apiKey) {
      sendJson(res, 500, {
        error: {
          message: 'Missing Gemini API key. Set GEMINI_API_KEY before starting the server, or enter a Gemini API key in the app settings.',
        },
      });
      return;
    }

    const upstreamUrl = new URL(geminiBaseUrl + geminiPath);
    const alt = localUrl.searchParams.get('alt');
    if (alt) upstreamUrl.searchParams.set('alt', alt);

    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': getHeader(req, 'content-type') || 'application/json; charset=utf-8',
        'x-goog-api-key': apiKey,
      },
      body: await readRequestBody(req),
    });

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    sendJson(res, 502, { error: { message: error.message || String(error) } });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  let filePath = resolve(root, normalize(requested).replace(/^[/\\]+/, ''));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      stat = await fs.stat(filePath);
    }
    if (!stat.isFile()) throw new Error('Not a file');

    res.writeHead(200, {
      'content-type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

await loadLocalEnv();

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/gtts/')) {
    await handleGoogleTts(req, res);
    return;
  }

  if (req.method === 'POST' && req.url?.startsWith('/gemini/')) {
    await handleGeminiProxy(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Method not allowed');
}).listen(port, '0.0.0.0', () => {
  console.log(`TalkingHead local server running at http://0.0.0.0:${port}/`);
});
