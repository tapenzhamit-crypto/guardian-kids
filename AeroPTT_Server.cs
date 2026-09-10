using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.Collections.Generic;

namespace AeroPTT
{
    class Program
    {
        static int httpPort = 8080;
        static int httpsPort = 8443;
        static int wsPort = 8081;
        static int wssPort = 8444;
        static string publicDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "public");
        static string pfxPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server.pfx");
        static X509Certificate2 serverCert = null;

        static List<Stream> wsClients = new List<Stream>();
        static readonly object lockObj = new object();

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.Title = "AeroPTT - Tactical Radio Server (HTTPS & HTTP)";

            string localIp = GetLocalIPAddress();

            // Load SSL certificate if present
            if (File.Exists(pfxPath))
            {
                try
                {
                    serverCert = new X509Certificate2(pfxPath, "aeroptt");
                }
                catch { }
            }

            TcpListener httpListener = StartListener(httpPort);
            TcpListener httpsListener = (serverCert != null) ? StartListener(httpsPort) : null;
            TcpListener wsListener = StartListener(wsPort);
            TcpListener wssListener = (serverCert != null) ? StartListener(wssPort) : null;

            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("================================================================");
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("        📻  AEROPTT - ТАКТИЧЕСКАЯ РАЦИЯ (HTTPS / SECURE)        ");
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("================================================================");
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine(" [✓] Сервер защищенной связи успешно запущен!");
            Console.ResetColor();
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.White;
            Console.WriteLine("  💻 Компьютер:   https://localhost:" + httpsPort + "  (или http://localhost:" + httpPort + ")");
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("  📱 Телефоны:    https://" + localIp + ":" + httpsPort);
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("================================================================");
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine(" 🔒 HTTPS разблокирует доступ к микрофону на всех телефонах!");
            Console.WriteLine(" При первом открытии браузер покажет 'Подключение не защищено'");
            Console.WriteLine(" -> Нажмите 'Дополнительно' (Advanced) -> 'Перейти на сайт' (Proceed)");
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("================================================================");
            Console.ResetColor();

            // WebSocket threads
            if (wsListener != null)
            {
                Thread t = new Thread(() => RunWebSocketListener(wsListener, false));
                t.IsBackground = true;
                t.Start();
            }
            if (wssListener != null)
            {
                Thread t = new Thread(() => RunWebSocketListener(wssListener, true));
                t.IsBackground = true;
                t.Start();
            }

            // HTTP server thread
            if (httpListener != null)
            {
                Thread t = new Thread(() => RunHttpListener(httpListener, false));
                t.IsBackground = true;
                t.Start();
            }

            // Main loop on HTTPS
            if (httpsListener != null)
            {
                RunHttpListener(httpsListener, true);
            }
            else if (httpListener != null)
            {
                while (true) Thread.Sleep(1000);
            }
        }

        static TcpListener StartListener(int port)
        {
            try
            {
                TcpListener l = new TcpListener(IPAddress.Any, port);
                l.Start();
                return l;
            }
            catch { return null; }
        }

        static string GetLocalIPAddress()
        {
            try
            {
                using (Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, 0))
                {
                    socket.Connect("10.255.255.255", 1);
                    IPEndPoint endPoint = socket.LocalEndPoint as IPEndPoint;
                    return endPoint.Address.ToString();
                }
            }
            catch { return "127.0.0.1"; }
        }

        static void RunHttpListener(TcpListener listener, bool isHttps)
        {
            while (true)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(state => HandleHttpClient(client, isHttps));
                }
                catch { break; }
            }
        }

        static void HandleHttpClient(TcpClient client, bool isHttps)
        {
            Stream stream = null;
            try
            {
                client.ReceiveTimeout = 3000;
                client.SendTimeout = 3000;
                stream = client.GetStream();

                if (isHttps && serverCert != null)
                {
                    SslStream sslStream = new SslStream(stream, false);
                    sslStream.AuthenticateAsServer(serverCert, false, System.Security.Authentication.SslProtocols.Tls12, false);
                    stream = sslStream;
                }

                byte[] buffer = new byte[4096];
                int received = stream.Read(buffer, 0, buffer.Length);
                if (received <= 0) { client.Close(); return; }

                string requestStr = Encoding.UTF8.GetString(buffer, 0, received);
                string[] lines = requestStr.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                if (lines.Length == 0) { client.Close(); return; }

                string[] reqParts = lines[0].Split(' ');
                if (reqParts.Length < 2) { client.Close(); return; }

                string urlPath = reqParts[1].Split('?')[0].TrimStart('/');
                if (string.IsNullOrEmpty(urlPath)) urlPath = "index.html";

                string filePath = Path.Combine(publicDir, urlPath.Replace('/', Path.DirectorySeparatorChar));

                if (File.Exists(filePath))
                {
                    byte[] fileBytes = File.ReadAllBytes(filePath);
                    string mime = GetMimeType(filePath);

                    string header = "HTTP/1.1 200 OK\r\n" +
                                   "Content-Type: " + mime + "\r\n" +
                                   "Content-Length: " + fileBytes.Length + "\r\n" +
                                   "Access-Control-Allow-Origin: *\r\n" +
                                   "Cache-Control: no-cache, no-store\r\n" +
                                   "Connection: close\r\n\r\n";

                    byte[] headerBytes = Encoding.ASCII.GetBytes(header);
                    stream.Write(headerBytes, 0, headerBytes.Length);
                    stream.Write(fileBytes, 0, fileBytes.Length);
                    stream.Flush();
                }
                else
                {
                    byte[] notFound = Encoding.ASCII.GetBytes("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    stream.Write(notFound, 0, notFound.Length);
                }
            }
            catch { }
            finally
            {
                try { if (stream != null) stream.Close(); client.Close(); } catch { }
            }
        }

        static string GetMimeType(string path)
        {
            string ext = Path.GetExtension(path).ToLower();
            switch (ext)
            {
                case ".html": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                default: return "application/octet-stream";
            }
        }

        static void RunWebSocketListener(TcpListener listener, bool isWss)
        {
            while (true)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(state => HandleWebSocketClient(client, isWss));
                }
                catch { break; }
            }
        }

        static void HandleWebSocketClient(TcpClient client, bool isWss)
        {
            Stream stream = null;
            try
            {
                stream = client.GetStream();
                if (isWss && serverCert != null)
                {
                    SslStream ssl = new SslStream(stream, false);
                    ssl.AuthenticateAsServer(serverCert, false, System.Security.Authentication.SslProtocols.Tls12, false);
                    stream = ssl;
                }

                byte[] buffer = new byte[4096];
                int received = stream.Read(buffer, 0, buffer.Length);
                if (received <= 0) { client.Close(); return; }

                string request = Encoding.UTF8.GetString(buffer, 0, received);
                string secKey = "";
                foreach (string line in request.Split(new[] { "\r\n" }, StringSplitOptions.None))
                {
                    if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    {
                        secKey = line.Substring(18).Trim();
                        break;
                    }
                }

                if (string.IsNullOrEmpty(secKey)) { client.Close(); return; }

                string responseKey;
                using (SHA1 sha1 = SHA1.Create())
                {
                    byte[] hash = sha1.ComputeHash(Encoding.UTF8.GetBytes(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
                    responseKey = Convert.ToBase64String(hash);
                }

                string handshake = "HTTP/1.1 101 Switching Protocols\r\n" +
                                  "Upgrade: websocket\r\n" +
                                  "Connection: Upgrade\r\n" +
                                  "Sec-WebSocket-Accept: " + responseKey + "\r\n\r\n";
                byte[] hBytes = Encoding.ASCII.GetBytes(handshake);
                stream.Write(hBytes, 0, hBytes.Length);
                stream.Flush();

                lock (lockObj) { wsClients.Add(stream); }

                while (true)
                {
                    byte[] head = new byte[2];
                    if (ReadExact(stream, head, 2) <= 0) break;

                    int opcode = head[0] & 0x0F;
                    if (opcode == 0x8) break; // Close

                    bool masked = (head[1] & 0x80) != 0;
                    long payloadLen = head[1] & 0x7F;

                    if (payloadLen == 126)
                    {
                        byte[] ext = new byte[2];
                        if (ReadExact(stream, ext, 2) <= 0) break;
                        payloadLen = (ext[0] << 8) | ext[1];
                    }
                    else if (payloadLen == 127)
                    {
                        byte[] ext = new byte[8];
                        if (ReadExact(stream, ext, 8) <= 0) break;
                        payloadLen = BitConverter.ToInt64(ext, 0);
                    }

                    byte[] masks = new byte[4];
                    if (masked && ReadExact(stream, masks, 4) <= 0) break;

                    byte[] payload = new byte[payloadLen];
                    if (ReadExact(stream, payload, (int)payloadLen) <= 0) break;

                    if (masked)
                    {
                        for (int i = 0; i < payloadLen; i++) payload[i] ^= masks[i % 4];
                    }

                    if (opcode == 0x1 || opcode == 0x2) // Text or Binary
                    {
                        byte[] frame = MakeWsFrame(payload, opcode == 0x2);
                        lock (lockObj)
                        {
                            List<Stream> dead = new List<Stream>();
                            foreach (var peer in wsClients)
                            {
                                if (peer != stream)
                                {
                                    try { peer.Write(frame, 0, frame.Length); peer.Flush(); }
                                    catch { dead.Add(peer); }
                                }
                            }
                            foreach (var d in dead) wsClients.Remove(d);
                        }
                    }
                }
            }
            catch { }
            finally
            {
                lock (lockObj) { if (stream != null) wsClients.Remove(stream); }
                try { if (stream != null) stream.Close(); client.Close(); } catch { }
            }
        }

        static int ReadExact(Stream stream, byte[] buffer, int length)
        {
            int total = 0;
            while (total < length)
            {
                int read = stream.Read(buffer, total, length - total);
                if (read <= 0) return 0;
                total += read;
            }
            return total;
        }

        static byte[] MakeWsFrame(byte[] payload, bool isBinary)
        {
            MemoryStream ms = new MemoryStream();
            byte opcode = (byte)(isBinary ? 0x82 : 0x81);
            ms.WriteByte(opcode);

            if (payload.Length <= 125)
            {
                ms.WriteByte((byte)payload.Length);
            }
            else if (payload.Length <= 65535)
            {
                ms.WriteByte(126);
                ms.WriteByte((byte)(payload.Length >> 8));
                ms.WriteByte((byte)(payload.Length & 0xFF));
            }
            else
            {
                ms.WriteByte(127);
                byte[] lenBytes = BitConverter.GetBytes((long)payload.Length);
                Array.Reverse(lenBytes);
                ms.Write(lenBytes, 0, 8);
            }

            ms.Write(payload, 0, payload.Length);
            return ms.ToArray();
        }
    }
}
