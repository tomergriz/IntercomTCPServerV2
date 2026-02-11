require('dotenv').config();

const net = require('net');
const { createClient } = require('@supabase/supabase-js');

// הגדרות Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[Error] Missing Supabase configuration.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const HOST = '0.0.0.0';
const TCP_PORT = process.env.PORT || 8080;

const lastHeartbeat = {};
const MIN_INTERVAL_MS = 60000; 

const server = net.createServer((socket) => {
  const clientAddress = socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New Connection: ${clientAddress}`);

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
      socket.write(JSON.stringify({ status: "ok", ts: Math.floor(currentTime/1000) }) + '\n');

    } catch (err) {
      console.error(`[Error] Processing failed:`, err.message);
    }
  });

  socket.on('error', (err) => console.error(`Socket error: ${err.message}`));
});

server.listen(TCP_PORT, HOST, () => {
  console.log(`TCP Server is running on port ${TCP_PORT}`);
});