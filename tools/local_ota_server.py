#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AeroPTT / Guardian - Local OTA Update Server
Запускает локальный HTTP-сервер для мгновенного обновления по воздуху (OTA) по домашней сети Wi-Fi.
"""

import http.server
import socketserver
import socket
import os
import json
import sys

PORT = 8080

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Connect to any remote IP (doesn't actually send packets) to find local interface IP
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def find_latest_apk(project_root):
    candidates = [
        os.path.join(project_root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
        os.path.join(project_root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
        os.path.join(project_root, 'app-debug.apk')
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None

def main():
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    apk_path = find_latest_apk(project_root)
    local_ip = get_local_ip()

    if not apk_path:
        print("=" * 65)
        print("ВНИМАНИЕ: Скомпилированный APK файл пока не найден!")
        print("Сначала соберите проект в Android Studio:")
        print("Build -> Build Bundle(s) / APK(s) -> Build APK(s)")
        print("=" * 65)
    else:
        apk_size_mb = os.path.getsize(apk_path) / (1024 * 1024)
        print("=" * 65)
        print(f"Найден APK: {apk_path}")
        print(f"Размер: {apk_size_mb:.2f} МБ")
        print("=" * 65)

    # Change working dir to directory containing APK or serve files directly
    serve_dir = os.path.dirname(apk_path) if apk_path else project_root
    os.chdir(serve_dir)

    apk_filename = os.path.basename(apk_path) if apk_path else "app-debug.apk"
    apk_url = f"http://{local_ip}:{PORT}/{apk_filename}"
    manifest_url = f"http://{local_ip}:{PORT}/version.json"

    # Write version.json manifest
    manifest_data = {
        "versionCode": 9999,
        "versionName": "2.1.0-LocalOTA",
        "apkUrl": apk_url,
        "changelog": "Локальное автоматическое обновление AeroPTT Guardian"
    }
    with open("version.json", "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2, ensure_ascii=False)

    print("\n" + "🚀 " * 15)
    print(f"СЕРВЕР ЛОКАЛЬНОГО ОБНОВЛЕНИЯ ЗАПУЩЕН НА ПОРТУ {PORT}!")
    print("=" * 65)
    print("Вставьте в приложении Guardian (в Настройках -> Обновление):")
    print(f"👉 ПРЯМАЯ ССЫЛКА НА APK:  {apk_url}")
    print(f"👉 ИЛИ ССЫЛКА НА МАНИФЕСТ: {manifest_url}")
    print("=" * 65)
    print("Нажмите на телефоне «🔄 Проверить и установить обновление».")
    print("Служба Guardian автоматически нажмет кнопку «Установить»!")
    print("=" * 65)
    print("Для остановки сервера нажмите Ctrl+C\n")

    class CustomHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Access-Control-Allow-Origin', '*')
            super().end_headers()

    with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nСервер остановлен.")

if __name__ == '__main__':
    main()
