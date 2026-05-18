require('dotenv').config();

const net = require('net');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// הגדרות Supabase
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[Error] Missing Supabase configuration. Please check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const HOST = '0.0.0.0';
const TCP_PORT = process.env.PORT || 8080;
const HTTP_PORT = process.env.HTTP_PORT || 3000;

const israelTime = () => new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour12: false });

const lastHeartbeat = {};
const commandQueue = {};
const lastSeen = {}; // IP -> timestamp
const MIN_INTERVAL_MS = 60000;
const activeClients = {}; // device_id -> socket

// האזנה לפקודות מ-Supabase (שליטה מרחוק)
supabase
  .channel('device_commands')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'intercom_commands' }, async payload => {
    const { id, device_id, command_data } = payload.new;
    console.log(`[Command] Received for ${device_id}: ${command_data}`);

    if (activeClients[device_id]) {
      const socket = activeClients[device_id];
      // Parsing command_data as JSON if possible, otherwise sending as string
      let parsedData;
      try {
        parsedData = JSON.parse(command_data);
      } catch (e) {
        parsedData = command_data;
      }

      socket.write(JSON.stringify({ type: 'command', data: parsedData }) + '\n');
      console.log(`[Command] Sent to device ${device_id}`);

      // Update status to 'sent' in Supabase
      const { error } = await supabase
        .from('intercom_commands')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', id);

      if (error) console.error(`[Supabase] Failed to update command status: ${error.message}`);
    } else {
      console.log(`[Command] Device ${device_id} is not connected.`);
      const { error } = await supabase
        .from('intercom_commands')
        .update({ status: 'failed', error_message: 'Device not connected' })
        .eq('id', id);
      if (error) console.error(`[Supabase] Failed to update command status: ${error.message}`);
    }
  })
  .subscribe();

const server = net.createServer(async (socket) => {
  const clientAddress = socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New Connection: ${clientAddress}`);

  // לוג התחברות ראשוני (ללא ID עדיין)
  const { error: connLogError } = await supabase
    .from('intercom_events')
    .insert([{
      event_type: 0,
      client_ip: clientAddress,
      raw_data: { status: 'connected' },
      created_at: new Date().toISOString()
    }]);
  if (connLogError) console.error('[Supabase] Connection log failed:', connLogError.message);

  socket.on('data', async (data) => {
    try {
      const rawString = data.toString().trim();
      const rawHex = data.toString('hex').match(/.{1,2}/g).join(' ');
      console.log(`[RAW] From ${clientAddress} | Text: "${rawString}" | Hex: ${rawHex} | Bytes: ${data.length}`);
      const jsonMatch = rawString.match(/\{.*\}/);

      if (!jsonMatch) {
        console.log(`[Received] Raw data from ${clientAddress}: ${rawString}`);
        activeClients[rawString] = socket;
        socket.deviceId = rawString;
        lastSeen[rawString] = israelTime();

        if (commandQueue[clientAddress] && commandQueue[clientAddress].length > 0) {
          const cmd = commandQueue[clientAddress].shift();
          console.log(`[Queue] Sending queued command to ${clientAddress}: ${cmd}`);
          socket.write(`${cmd}\r\n`);
        } else {
          socket.write(`OK ${israelTime()}\r\n`);
        }
        return;
      }

      const payload = JSON.parse(jsonMatch[0]);
      const deviceId = payload.pId || 'unknown';
      const eventType = payload.type;
      const currentTime = Date.now();

      // רישום המכשיר כפעיל לשליטה
      if (deviceId !== 'unknown') {
        activeClients[deviceId] = socket;
        socket.deviceId = deviceId; // שמירה לזיהוי בעת ניתוק
      }

      // סינון Heartbeat (סוג 6) - שומרים רק פעם בדקה
      if (eventType === 6 && lastHeartbeat[deviceId] && (currentTime - lastHeartbeat[deviceId] < MIN_INTERVAL_MS)) {
        console.log(`[Skip] Throttled Heartbeat: ${deviceId}`);
      } else {
        lastHeartbeat[deviceId] = currentTime;

        // --- שמירה נקייה + גיבוי מלא ---
        const { error } = await supabase
          .from('intercom_events')
          .insert([{
            event_type: eventType,        // עמודה נקייה למספר סוג האירוע
            device_id: deviceId,          // עמודה נקייה לזהות המכשיר
            client_ip: clientAddress,     // עמודה נקייה ל-IP
            raw_data: payload,            // גיבוי מלא! כאן יישמר כל ה-JSON למקרה שיש בו מידע נוסף
            created_at: new Date().toISOString()
          }]);

        if (error) {
          console.error(`[Supabase] Save failed: ${error.message}`);
        } else {
          console.log(`[Success] Data saved. Type: ${eventType}, Device: ${deviceId}`);
        }
      }

      socket.write(`OK ${israelTime()}\r\n`);

    } catch (err) {
      console.error(`[Error] Processing failed:`, err.message);
    }
  });

  socket.on('end', () => {
    if (socket.deviceId) {
      delete activeClients[socket.deviceId];
      console.log(`[Disconnect] Device ${socket.deviceId} connection ended.`);
    }
  });

  socket.on('close', () => {
    if (socket.deviceId) {
      delete activeClients[socket.deviceId];
    }
  });

  socket.on('error', (err) => {
    if (socket.deviceId) {
      delete activeClients[socket.deviceId];
    }
    console.error(`Socket error: ${err.message}`);
  });
});

server.listen(TCP_PORT, HOST, () => {
  console.log(`TCP Server is running on port ${TCP_PORT}`);
});

// HTTP API לשליחת פקודות ישירות למכשיר

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/devices') {
    const devices = Object.keys(activeClients);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: devices, count: devices.length, last_seen: lastSeen }));
    return;
  }

  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { device_id, command } = JSON.parse(body);
        if (!device_id || !command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing device_id or command' }));
          return;
        }
        if (!lastSeen[device_id]) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown device: ${device_id}`, known_devices: Object.keys(lastSeen) }));
          return;
        }
        const payload = typeof command === 'string' ? command : JSON.stringify(command);
        if (activeClients[device_id]) {
          activeClients[device_id].write(`${payload}\r\n`);
          console.log(`[Command] Sent immediately to ${device_id}: ${payload}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'sent', device_id, command }));
        } else {
          if (!commandQueue[device_id]) commandQueue[device_id] = [];
          commandQueue[device_id].push(payload);
          console.log(`[Queue] Command queued for ${device_id}: ${payload}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'queued', device_id, command, last_seen: lastSeen[device_id] }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP API is running on port ${HTTP_PORT}`);
});

// Graceful shutdown — שולח הודעה למכשירים לפני סגירה
const shutdown = () => {
  console.log('[Shutdown] Server shutting down, notifying devices...');
  Object.entries(activeClients).forEach(([id, socket]) => {
    try {
      socket.write('RECONNECT\r\n');
    } catch (e) {}
  });
  setTimeout(() => process.exit(0), 2000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);