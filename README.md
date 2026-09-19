# Reel Render Service

Microservicio ffmpeg para ensamblar reels (slideshow 9:16 + transiciones + musica).
Mismo patron que Browserless: n8n lo llama por HTTP Request.

## Deploy en Coolify

1. Sube esta carpeta a un repo Git (GitHub) o usa "Docker Compose" / "Dockerfile" en Coolify
2. En Coolify: New Resource -> Application -> desde el repo (o Dockerfile)
3. Variables de entorno:
   - RENDER_TOKEN = un-token-secreto-tuyo
   - PORT = 3000
4. Expon el puerto 3000 con un dominio (ej. reel.apps1.strattonagency.cloud)
5. Deploy

## Uso desde n8n (HTTP Request)

POST https://reel.tudominio.com/render
Headers: x-token: tu-token
Body (JSON):
{
  "scenes": [
    { "image_url": "https://.../scene0.png", "duration": 3.5 },
    { "image_url": "https://.../scene1.png", "duration": 3.5 }
  ],
  "audio_url": "https://.../musica.mp3",
  "width": 1080,
  "height": 1920,
  "fps": 30
}

Respuesta: el video MP4 (binario). En n8n, guardarlo y subirlo a storage.

## Uso desde n8n (HTTP Request) — /compress

Recomprime un video ya existente (por URL) para que entre bajo un tamaño
objetivo. Pensado para WhatsApp Estados: Evolution API acepta cualquier
video y lo marca "sent" igual, pero WhatsApp lo descarta en destino
("this video isn't available") pasado ~16MB — el reel propio que sube el
usuario en el wizard no tiene ese límite (hasta 4K, sin comprimir) porque
Instagram/Facebook/YouTube sí lo aguantan.

POST https://reel.tudominio.com/compress
Headers: x-token: tu-token
Body (JSON):
{
  "video_url": "https://.../video-original.mp4",
  "max_bytes": 15728640,
  "max_width": 720
}

`max_bytes` y `max_width` son opcionales (default 15MB / 720px de ancho).
Calcula el bitrate de video a partir de la duración real (ffprobe) para
entrar en `max_bytes` con ~10% de margen — un paso de encoder, no 2-pass.

Respuesta: el video MP4 recomprimido (binario), mismo patrón que /render.

## Health check
GET /health -> { ok: true }
