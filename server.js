// ============================================================
// Reel Render Service — slideshow 9:16 con transiciones + musica
// Recibe: { scenes:[{image_url, duration}], audio_url, transition, output }
// Devuelve: el video MP4 (o lo sube a storage y devuelve URL)
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

// Descargar un archivo (imagen/audio) a disco
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'reel-render' }));

app.post('/render', async (req, res) => {
  // auth simple por token
  if (req.headers['x-token'] !== TOKEN) {
    return res.status(401).json({ error: 'token invalido' });
  }
  const { scenes, audio_url, width = 1080, height = 1920, fps = 30 } = req.body;
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes requerido (array de {image_url, duration})' });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    // 1. descargar imagenes
    const imgs = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = path.join(work, `img${i}.png`);
      await download(scenes[i].image_url, p);
      imgs.push({ path: p, duration: scenes[i].duration || 3 });
    }
    // 2. descargar audio (opcional)
    let audioPath = null;
    if (audio_url) {
      audioPath = path.join(work, 'audio.mp3');
      await download(audio_url, audioPath);
    }

    // 3. construir el video con ffmpeg
    //    Cada imagen -> clip con zoom lento (Ken Burns) + crossfade entre clips
    const outPath = path.join(work, 'out.mp4');

    const inputs = [];
    imgs.forEach((im) => {
      inputs.push('-loop', '1', '-t', String(im.duration), '-i', im.path);
    });
    if (audioPath) inputs.push('-i', audioPath);

    // filtro por imagen: escalar cubriendo 9:16 + zoompan (Ken Burns)
    let filter = '';
    imgs.forEach((im, i) => {
      const frames = Math.round(im.duration * fps);
      filter += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`
             +  `crop=${width}:${height},`
             +  `zoompan=z='min(zoom+0.0015,1.15)':d=${frames}:s=${width}x${height}:fps=${fps},`
             +  `setsar=1[v${i}];`;
    });

    // encadenar con xfade (crossfade 0.5s)
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

    // duración real del video final (suma de escenas menos el solape de cada crossfade)
    let totalDuration = imgs.reduce((s, im) => s + im.duration, 0);
    if (imgs.length > 1) totalDuration -= (imgs.length - 1) * xdur;

    const args = [...inputs, '-filter_complex', filter, '-map', '[vout]'];
    if (audioPath) {
      // recorta el audio a la duración del video (-shortest) y aplica fade-out de 1s
      // justo antes del corte, para que no termine seco
      const fadeStart = Math.max(totalDuration - 1, 0);
      args.push(
        '-map', `${imgs.length}:a`,
        '-shortest',
        '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=1`,
        '-c:a', 'aac', '-b:a', '128k'
      );
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), '-y', outPath);

    await run('ffmpeg', args);

    // 4. devolver el video como binario
    const buf = fs.readFileSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
});

app.listen(PORT, () => console.log('reel-render en puerto ' + PORT));
