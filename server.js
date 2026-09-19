// ============================================================
// Reel Render Service — slideshow 9:16 con transiciones + musica
// Recibe: { scenes:[{image_url, duration}], audio_url, width, height, fps }
// Devuelve: el video MP4
//
// NOTA v5 (FIX DEFINITIVO): la causa raiz de "No such filter: ''"
// era el punto y coma final que quedaba al armar el filter_complex
// (cada segmento se concatena terminando en ';', incluido el
// ultimo). ffmpeg 6.x lo tolera silenciosamente; ffmpeg 5.1.9
// (Debian 12, el que corre en produccion) lo interpreta como un
// intento de declarar un filtro adicional vacio y falla. Se quita
// el ';' final antes de pasarlo a -filter_complex.
// Diagnosticado bisectando manualmente dentro del contenedor real
// con el ffmpeg real, no por prueba y error a ciegas.
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

app.get('/health', (req, res) => res.json({ ok: true, service: 'reel-render', version: 'v5' }));

app.post('/render', async (req, res) => {
  if (req.headers['x-token'] !== TOKEN) {
    return res.status(401).json({ error: 'token invalido' });
  }
  const { scenes, audio_url, width = 1080, height = 1920, fps = 30 } = req.body;
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'scenes requerido (array de {image_url, duration})' });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    const imgs = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = path.join(work, `img${i}.png`);
      await download(scenes[i].image_url, p);
      imgs.push({ path: p, duration: scenes[i].duration || 3 });
    }
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

    // filtro por imagen: escalar cubriendo 9:16 + normalizar fps.
    let filter = '';
    imgs.forEach((im, i) => {
      filter += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`
             +  `crop=${width}:${height},setsar=1,fps=${fps}[v${i}];`;
    });

    // encadenar con xfade (crossfade 0.5s)
    const xdur = 0.5;
    if (imgs.length === 1) {
      filter += `[v0]copy[vout];`;
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

    // FIX CRITICO: quitar el ';' final. ffmpeg 5.1.9 lo interpreta
    // como un filtro vacio adicional y falla con "No such filter: ''".
    filter = filter.replace(/;$/, '');

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
    // -movflags +faststart: mueve el índice del MP4 (moov atom) al principio
    // del archivo. Sin esto queda al final (después de todo el video) y
    // reproductores que muestran vista previa antes de bajar el archivo
    // completo —WhatsApp Estados incluido— no lo pueden reproducir.
    // Confirmado leyendo la estructura real de un archivo generado por este
    // servicio: moov aparecía después de mdat.
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', '-y', outPath);

    await run('ffmpeg', args);

    const buf = fs.readFileSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
});

// ============================================================
// /compress — recomprime un video existente para que entre bajo un
// tamaño objetivo (pensado para WhatsApp Estados: Evolution API acepta
// cualquier peso y lo marca "sent" igual, pero WhatsApp lo descarta en
// destino ["this video isn't available"] pasado ~16MB — confirmado en
// vivo con reels propios de 40-50MB subidos crudos, sin comprimir).
// Calcula el bitrate de video a partir de duración real (ffprobe) para
// entrar en max_bytes con margen, y limita el ancho porque a esa escala
// (status/estado) no hace falta más resolución para bajar bitrate.
// ============================================================
app.post('/compress', async (req, res) => {
  if (req.headers['x-token'] !== TOKEN) {
    return res.status(401).json({ error: 'token invalido' });
  }
  const { video_url, max_bytes = 15 * 1024 * 1024, max_width = 720 } = req.body;
  if (!video_url) {
    return res.status(400).json({ error: 'video_url requerido' });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-'));
  try {
    const inPath = path.join(work, 'in.mp4');
    await download(video_url, inPath);

    const probeOut = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', inPath]);
    const duration = Number(JSON.parse(probeOut).format?.duration);
    if (!duration || !isFinite(duration) || duration <= 0) {
      return res.status(500).json({ error: 'no se pudo leer la duracion del video de entrada' });
    }

    // 90% del objetivo como margen contra el overshoot típico de un encoder
    // de un solo paso con bitrate objetivo (no 2-pass, para no duplicar el
    // tiempo de render en un microservicio que ya vive justo de recursos).
    const audioKbps = 96;
    const targetTotalKbps = ((max_bytes * 8) / 1024 / duration) * 0.9;
    const videoKbps = Math.min(Math.max(Math.round(targetTotalKbps - audioKbps), 250), 4000);

    const outPath = path.join(work, 'out.mp4');
    await run('ffmpeg', [
      '-i', inPath,
      '-vf', `scale='min(iw,${max_width})':-2`,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.2)}k`, '-bufsize', `${videoKbps * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      // Mismo motivo que en /render: sin faststart, WhatsApp Estados no
      // reproduce el archivo (moov atom al final del MP4).
      '-movflags', '+faststart',
      '-y', outPath,
    ]);

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
