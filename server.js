import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use(express.static(PUBLIC_DIR));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = http.createServer(app);

// WebSocket broadcast server multiplexed on the same port
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    // Broadcast to all other connected clients
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Guardian Kids server running on http://0.0.0.0:${PORT}`);
});
