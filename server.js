// ============================================================
// Reel Render Service — slideshow 9:16 con transiciones + musica
// Recibe: { scenes:[{image_url, duration}], audio_url, width, height, fps }
// Devuelve: el video MP4
//
// NOTA v4: agrega logging de diagnostico. El filtro sin zoompan
// (v3) sigue fallando en produccion con "No such filter: ''" pese
// a funcionar identico en pruebas locales. Este log imprime el
// filter_complex y los args EXACTOS que se le mandan a ffmpeg,
// para diagnosticar contra los logs reales de Coolify en vez de
// seguir adivinando.
// ============================================================
const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TOKEN = process.env.RENDER_TOKEN || 'cambia-este-token';
const PORT = process.env.PORT || 3000;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    mod.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' para ' + url)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      resolve(stdout);
    });
  });
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'reel-render', version: 'v4-debug' }));

app.post('/render', async (req, res) => {
  if (req.headers['x-token'] !== TOKEN) {
    return res.status(401).json({ error: 'token invalido' });
  }
  const { scenes, audio_url, width = 1080, height = 1920, fps = 30 } = req.body;
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes requerido (array de {image_url, duration})' });
  }

  console.log('=== NUEVA REQUEST /render ===');
  console.log('scenes recibidas (raw):', JSON.stringify(scenes));
  console.log('width/height/fps:', width, height, fps, 'tipos:', typeof width, typeof height, typeof fps);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    const imgs = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = path.join(work, `img${i}.png`);
      await download(scenes[i].image_url, p);
      imgs.push({ path: p, duration: scenes[i].duration || 3 });
    }
    console.log('imgs construidos:', JSON.stringify(imgs));

    let audioPath = null;
    if (audio_url) {
      audioPath = path.join(work, 'audio.mp3');
      await download(audio_url, audioPath);
    }

    const outPath = path.join(work, 'out.mp4');

    const inputs = [];
    imgs.forEach((im) => {
      inputs.push('-loop', '1', '-t', String(im.duration), '-i', im.path);
    });
    if (audioPath) inputs.push('-i', audioPath);

    let filter = '';
    imgs.forEach((im, i) => {
      filter += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`
             +  `crop=${width}:${height},setsar=1,fps=${fps}[v${i}];`;
    });

    const xdur = 0.5;
    if (imgs.length === 1) {
      filter += `[v0]null[vout];`;
    } else {
      let prev = 'v0';
      let offset = imgs[0].duration - xdur;
      for (let i = 1; i < imgs.length; i++) {
        const out = (i === imgs.length - 1) ? 'vout' : `vx${i}`;
        filter += `[${prev}][v${i}]xfade=transition=fade:duration=${xdur}:offset=${offset.toFixed(3)}[${out}];`;
        prev = out;
        offset += imgs[i].duration - xdur;
      }
    }

    let totalDuration = imgs.reduce((s, im) => s + im.duration, 0);
    if (imgs.length > 1) totalDuration -= (imgs.length - 1) * xdur;

    const args = [...inputs, '-filter_complex', filter, '-map', '[vout]'];
    if (audioPath) {
      const fadeStart = Math.max(totalDuration - 1, 0);
      args.push(
        '-map', `${imgs.length}:a`,
        '-shortest',
        '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=1`,
        '-c:a', 'aac', '-b:a', '128k'
      );
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), '-y', outPath);

    console.log('=== FILTER_COMPLEX EXACTO ===');
    console.log(filter);
    console.log('=== ARGS COMPLETOS (uno por linea) ===');
    args.forEach((a, i) => console.log(i + ': [' + a + ']'));
    console.log('=== FIN DEBUG, llamando ffmpeg ===');

    await run('ffmpeg', args);

    const buf = fs.readFileSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(buf);
  } catch (e) {
    console.log('=== ERROR EN /render ===', String(e.message || e));
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
});

app.listen(PORT, () => console.log('reel-render en puerto ' + PORT));
