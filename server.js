import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const PORT = process.env.PORT || 3000;
const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const BAIDU_APP_ID = process.env.BAIDU_APP_ID || '';
const BAIDU_DEV_PID = Number(process.env.BAIDU_DEV_PID || 1737);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({
  origin: ALLOWED_ORIGIN === '*'
    ? true
    : ALLOWED_ORIGIN.split(',').map(s => s.trim())
}));

app.use(express.json({ limit: '12mb' }));

let cachedToken = null;
let tokenExpiresAt = 0;

async function getBaiduToken() {
  const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', BAIDU_API_KEY);
  url.searchParams.set('client_secret', BAIDU_SECRET_KEY);

  console.log("Requesting token...");
  console.log("API Key starts:", BAIDU_API_KEY?.slice(0, 6));
  console.log("Secret starts:", BAIDU_SECRET_KEY?.slice(0, 6));

  const res = await fetch(url, { method: 'POST' });

  const text = await res.text();

  console.log("HTTP:", res.status);
  console.log("Response:", text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text);
  }

  if (!res.ok || !data.access_token) {
    throw new Error(`Token failed: ${text}`);
  }

  return data.access_token;
}

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

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

    const ff = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let err = '';

    ff.stderr.on('data', d => {
      err += d.toString();
    });

    ff.on('error', reject);

    ff.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}: ${err.slice(-1000)}`));
      }
    });
  });
}

async function convertBufferToWav16k(buffer, originalName = 'speech.webm') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emoji-speech-'));
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'speech.webm';
  const inputPath = path.join(dir, safeName);
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

  if (BAIDU_APP_ID) {
    body.appid = BAIDU_APP_ID;
  }

  const res = await fetch('https://vop.baidu.com/server_api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
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

async function synthesizeWithBaidu(text, options = {}) {
  const token = await getBaiduToken();

  const url = new URL('https://tsn.baidu.com/text2audio');
  url.searchParams.set('tex', text);
  url.searchParams.set('tok', token);
  url.searchParams.set('cuid', String(options.cuid || 'emoji-english').slice(0, 60));
  url.searchParams.set('ctp', '1');
  url.searchParams.set('lan', 'en');

  url.searchParams.set('spd', String(options.speed || 5));
  url.searchParams.set('pit', String(options.pitch || 5));
  url.searchParams.set('vol', String(options.volume || 8));
  url.searchParams.set('per', String(options.voice || 0));
  url.searchParams.set('aue', '3');

  const res = await fetch(url);
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok || contentType.includes('application/json')) {
    const errText = await res.text();
    throw new Error(`Baidu TTS failed: ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'emoji-english-baidu-speech',
    hasKeys: !!(BAIDU_API_KEY && BAIDU_SECRET_KEY),
    dev_pid: BAIDU_DEV_PID,
    tts: true
  });
});

app.post('/api/baidu-speech', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({
        ok: false,
        error: 'missing_audio'
      });
    }

    const wav = await convertBufferToWav16k(
      req.file.buffer,
      req.file.originalname
    );

    const baidu = await recognizeWithBaidu(
      wav,
      req.body?.cuid || req.ip || 'emoji-english'
    );

    res.json({
      ok: true,
      text: (baidu.result || []).join(' ').trim(),
      result: baidu.result || [],
      baidu
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message,
      baidu: error.baidu || null
    });
  }
});

app.get('/tts', async (req, res) => {
  try {
    const text = String(req.query.text || '').trim();

    if (!text) {
      return res.status(400).send('Missing text');
    }

    if (text.length > 500) {
      return res.status(400).send('Text too long');
    }

    const audio = await synthesizeWithBaidu(text, {
      cuid: req.query.cuid || req.ip || 'emoji-english',
      speed: req.query.speed || 5,
      pitch: req.query.pitch || 5,
      volume: req.query.volume || 8,
      voice: req.query.voice || 0
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    res.send(audio);
  } catch (error) {
    console.error(error);
    res.status(500).send('TTS failed');
  }
});

app.listen(PORT, () => {
  console.log(`Emoji English Baidu speech backend listening on port ${PORT}`);
});
