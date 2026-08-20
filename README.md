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

## Health check
GET /health -> { ok: true }
