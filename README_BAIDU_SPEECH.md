# Emoji English Baidu Speech Backend

This small Node backend keeps the Baidu Secret Key off Neocities.

## Environment variables

Set these on your host:

```bash
BAIDU_APP_ID=your_app_id
BAIDU_API_KEY=your_api_key
BAIDU_SECRET_KEY=your_secret_key
# Optional. 1737 is the English short-speech model in Baidu's standard REST API docs.
BAIDU_DEV_PID=1737
# Optional. For production, set this to your Neocities origin.
ALLOWED_ORIGIN=https://davidiom.neocities.org
```

## Run locally

```bash
cd backend
npm install
npm start
```

Health check:

```text
http://localhost:3000/api/health
```

Speech endpoint:

```text
POST /api/baidu-speech
multipart/form-data field: audio
```

The server converts browser audio to 16k mono WAV using ffmpeg-static, sends it to Baidu, and returns recognized text.
