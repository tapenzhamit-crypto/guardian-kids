#!/usr/bin/env python3
"""
AeroPTT - Local Walkie-Talkie Server
Ultra-fast, zero-dependency local server with WebSocket broadcast and auto-IP detection.
Works completely offline over Wi-Fi or Mobile Hotspot.
"""

import os
import sys
import json
import socket
import http.server
import socketserver
import threading
import mimetypes
import struct
import hashlib
import base64

# Set proper MIME types
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('image/svg+xml', '.svg')

PORT = 8080
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

def get_local_ip():
    """Detect local LAN/Wi-Fi IP address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = '127.0.0.1'
    finally:
        s.close()
    return ip

class CustomHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def log_message(self, format, *args):
        # Silence standard static file access logs
        pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

def run_http_server(ip, port):
    with socketserver.TCPServer(('0.0.0.0', port), CustomHTTPHandler) as httpd:
        httpd.allow_reuse_address = True
        print(f"[+] HTTP Server running at http://{ip}:{port}")
        httpd.serve_forever()

# --- Lightweight WebSocket Server for PTT Audio & Signaling ---
CONNECTED_CLIENTS = set()
CLIENT_LOCK = threading.Lock()

def make_ws_frame(payload_bytes, is_binary=True):
    length = len(payload_bytes)
    opcode = 0x82 if is_binary else 0x81  # 0x82 = Binary, 0x81 = Text
    
    if length <= 125:
        header = struct.pack('!BB', opcode, length)
    elif length <= 65535:
        header = struct.pack('!BBH', opcode, 126, length)
    else:
        header = struct.pack('!BBQ', opcode, 127, length)
    return header + payload_bytes

def parse_ws_frame(sock):
    try:
        head = sock.recv(2)
        if len(head) < 2:
            return None, None
        b1, b2 = head[0], head[1]
        opcode = b1 & 0x0F
        masked = (b2 & 0x80) != 0
        payload_len = b2 & 0x7F
        
        if payload_len == 126:
            ext_len = sock.recv(2)
            if len(ext_len) < 2: return None, None
            payload_len = struct.unpack('!H', ext_len)[0]
        elif payload_len == 127:
            ext_len = sock.recv(8)
            if len(ext_len) < 8: return None, None
            payload_len = struct.unpack('!Q', ext_len)[0]
            
        masks = sock.recv(4) if masked else None
        if masked and len(masks) < 4:
            return None, None
            
        data = bytearray()
        while len(data) < payload_len:
            chunk = sock.recv(min(4096, payload_len - len(data)))
            if not chunk:
                return None, None
            data.extend(chunk)
            
        if masked:
            for i in range(len(data)):
                data[i] ^= masks[i % 4]
                
        return opcode, bytes(data)
    except Exception:
        return None, None

def handle_ws_client(client_socket, addr):
    try:
        request = client_socket.recv(4096).decode('utf-8', errors='ignore')
        headers = {}
        for line in request.split('\r\n')[1:]:
            if ': ' in line:
                k, v = line.split(': ', 1)
                headers[k.lower()] = v
                
        sec_key = headers.get('sec-websocket-key')
        if not sec_key:
            client_socket.close()
            return
            
        magic = sec_key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        sec_accept = base64.b64encode(hashlib.sha1(magic.encode()).digest()).decode()
        
        handshake_resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {sec_accept}\r\n\r\n"
        )
        client_socket.sendall(handshake_resp.encode())
        
        with CLIENT_LOCK:
            CONNECTED_CLIENTS.add(client_socket)
            
        while True:
            opcode, data = parse_ws_frame(client_socket)
            if opcode is None or opcode == 0x8:  # Close
                break
                
            if opcode in (0x1, 0x2):  # Text or Binary audio
                frame = make_ws_frame(data, is_binary=(opcode == 0x2))
                with CLIENT_LOCK:
                    to_remove = set()
                    for client in CONNECTED_CLIENTS:
                        if client != client_socket:
                            try:
                                client.sendall(frame)
                            except Exception:
                                to_remove.add(client)
                    CONNECTED_CLIENTS.difference_update(to_remove)
    except Exception:
        pass
    finally:
        with CLIENT_LOCK:
            CONNECTED_CLIENTS.discard(client_socket)
        try:
            client_socket.close()
        except Exception:
            pass

def run_ws_server(port=8081):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', port))
    server.listen(128)
    print(f"[+] PTT WebSocket Audio Broker running on port {port}")
    while True:
        client, addr = server.accept()
        t = threading.Thread(target=handle_ws_client, args=(client, addr), daemon=True)
        t.start()

def print_banner(ip):
    url = f"http://{ip}:{PORT}"
    print("=" * 64)
    print("      📻 AeroPTT - ТАКТИЧЕСКАЯ РАЦИЯ / WALKIE-TALKIE       ")
    print("=" * 64)
    print(f" [✓] Сервер успешно запущен!")
    print(f" [✓] Откройте в браузере на этом компьютере:  http://localhost:{PORT}")
    print(f" [✓] Откройте на мобильных телефонах (Wi-Fi): {url}")
    print("=" * 64)
    print(" Совет: Подключите оба смартфона к одной Wi-Fi сети или раздайте")
    print(" точку доступа (Hotspot) с одного телефона на другой.")
    print("=" * 64)

if __name__ == '__main__':
    local_ip = get_local_ip()
    print_banner(local_ip)
    
    ws_thread = threading.Thread(target=run_ws_server, args=(8081,), daemon=True)
    ws_thread.start()
    
    run_http_server(local_ip, PORT)
