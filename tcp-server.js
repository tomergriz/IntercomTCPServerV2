require('dotenv').config();

const net = require('net');
const { createClient } = require('@supabase/supabase-js');

// הגדרות Supabase
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[Error] Missing Supabase configuration. Please check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const HOST = '0.0.0.0';
const TCP_PORT = process.env.PORT || 8080;

const lastHeartbeat = {};
const MIN_INTERVAL_MS = 60000;
const activeClients = {}; // device_id -> socket

// האזנה לפקודות מ-Supabase (שליטה מרחוק)
supabase
  .channel('device_commands')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'intercom_commands' }, payload => {
    const { device_id, command_data } = payload.new;
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
    } else {
      console.log(`[Command] Device ${device_id} is not connected.`);
    }
  })
  .subscribe();

const server = net.createServer(async (socket) => {
  const clientAddress = socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New Connection: ${clientAddress}`);

  // לוג התחברות ראשוני (ללא ID עדיין)
  await supabase
    .from('intercom_events')
    .insert([{
      event_type: 0, // 'Connection' status
      client_ip: clientAddress,
      raw_data: { status: 'connected' },
      created_at: new Date().toISOString()
    }]).catch(err => console.error('[Supabase] Connection log failed:', err.message));

  socket.on('data', async (data) => {
    try {
      const rawString = data.toString().trim();
      const jsonMatch = rawString.match(/\{.*\}/);

      if (!jsonMatch) {
        console.log(`[Log] Received non-JSON data: ${rawString}`);
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

        if (error) throw error;
        console.log(`[Success] Data saved. Type: ${eventType}, Device: ${deviceId}`);
      }

      // שליחת תשובה למכשיר
      socket.write(JSON.stringify({ status: "ok", ts: Math.floor(currentTime / 1000) }) + '\n');

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