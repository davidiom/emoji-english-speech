import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PORT = process.env.PORT || 3000;
const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const BAIDU_APP_ID = process.env.BAIDU_APP_ID || '';
// English short-speech model. Use BAIDU_DEV_PID to override if Baidu changes model IDs.
const BAIDU_DEV_PID = Number(process.env.BAIDU_DEV_PID || 1737);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map(s => s.trim()) }));
app.use(express.json({ limit: '12mb' }));

let cachedToken = null;
let tokenExpiresAt = 0;

async function getBaiduToken() {
  if (!BAIDU_API_KEY || !BAIDU_SECRET_KEY) {
    throw new Error('Missing BAIDU_API_KEY or BAIDU_SECRET_KEY environment variable.');
  }
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', BAIDU_API_KEY);
  url.searchParams.set('client_secret', BAIDU_SECRET_KEY);

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Baidu token failed: ${JSON.stringify(data)}`);
  }
  cachedToken = data.access_token;
  tokenExpiresAt = now + Number(data.expires_in || 0) * 1000;
  return cachedToken;
}

function runFfmpegToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-acodec', 'pcm_s16le',
      outputPath
    ];
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed with code ${code}: ${err.slice(-1000)}`));
    });
  });
}

async function convertBufferToWav16k(buffer, originalName = 'speech.webm') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emoji-speech-'));
  const inputPath = path.join(dir, originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'speech.webm');
  const outputPath = path.join(dir, 'speech_16k.wav');
  try {
    await fs.writeFile(inputPath, buffer);
    await runFfmpegToWav(inputPath, outputPath);
    return await fs.readFile(outputPath);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recognizeWithBaidu(wavBuffer, cuid = 'emoji-english') {
  const token = await getBaiduToken();
  const body = {
    format: 'wav',
    rate: 16000,
    channel: 1,
    cuid: String(cuid || 'emoji-english').slice(0, 60),
    token,
    speech: wavBuffer.toString('base64'),
    len: wavBuffer.length,
    dev_pid: BAIDU_DEV_PID
  };
  if (BAIDU_APP_ID) body.appid = BAIDU_APP_ID;

  const res = await fetch('https://vop.baidu.com/server_api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || data.err_no !== 0) {
    const err = new Error(`Baidu ASR failed: ${JSON.stringify(data)}`);
    err.baidu = data;
    throw err;
  }
  return data;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'emoji-english-baidu-speech', hasKeys: !!(BAIDU_API_KEY && BAIDU_SECRET_KEY), dev_pid: BAIDU_DEV_PID });
});

app.post('/api/baidu-speech', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: 'missing_audio' });
    const wav = await convertBufferToWav16k(req.file.buffer, req.file.originalname);
    const baidu = await recognizeWithBaidu(wav, req.body?.cuid || req.ip || 'emoji-english');
    res.json({ ok: true, text: (baidu.result || []).join(' ').trim(), result: baidu.result || [], baidu });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message, baidu: error.baidu || null });
  }
});

app.listen(PORT, () => {
  console.log(`Emoji English Baidu speech backend listening on port ${PORT}`);
});
