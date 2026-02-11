require('dotenv').config();

const net = require('net');
const { createClient } = require('@supabase/supabase-js');

// הגדרות Supabase מהסביבה (Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // עדיף Service Key לכתיבה מהשרת

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[Error] Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const HOST = '0.0.0.0';
// במקום להשתמש ב-TCP_PORT נפרד, נסה להקשיב לפורט ש-Railway נותן
const TCP_PORT = process.env.PORT || 9000;

// אובייקט לשמירת מצב אחרון של מכשירים (כדי למנוע כפילויות)
const lastHeartbeat = {};
const MIN_INTERVAL_MS = 60000; // שמירה ל-DB רק פעם בדקה עבור אותו מכשיר, אלא אם המידע השתנה

const server = net.createServer((socket) => {
  const clientAddress = socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] New Connection: ${clientAddress}`);

  socket.on('data', async (data) => {
    try {
      const rawString = data.toString().trim();
      // ניקוי תווים לא רצויים שנוספים לפעמים מפקודות AT
      const jsonMatch = rawString.match(/\{.*\}/);

      if (!jsonMatch) {
        console.log(`[Log] Received non-JSON data: ${rawString}`);
        return;
      }

      const payload = JSON.parse(jsonMatch[0]);
      const deviceId = payload.pId || 'unknown';
      const currentTime = Date.now();

      // מנגנון סינון: אם זה סוג 6 (לרוב Heartbeat) ושלחנו לאחרונה - נתעלם מהכתיבה ל-DB
      if (payload.type === 6 &&
        lastHeartbeat[deviceId] &&
        (currentTime - lastHeartbeat[deviceId] < MIN_INTERVAL_MS)) {
        console.log(`[Skip] Heartbeat for ${deviceId} throttled.`);
      } else {
        // עדכון זמן אחרון
        lastHeartbeat[deviceId] = currentTime;

        // שליחה ל-Supabase
        const { error } = await supabase
          .from('intercom_events')
          .insert([{
            event_type: payload.type,
            device_id: deviceId,
            raw_data: payload,
            client_ip: clientAddress
          }]);

        if (error) throw error;
        console.log(`[Success] Data saved for device ${deviceId}`);
      }

      // החזרת אישור לאינטרקום (הכרחי כדי שלא ינסה שוב ושוב)
      socket.write(JSON.stringify({ status: "ok", timestamp: currentTime }) + '\n');

    } catch (err) {
      console.error(`[Error] Processing failed:`, err.message);
    }
  });

  socket.on('error', (err) => console.error(`Socket error: ${err.message}`));
});

server.listen(TCP_PORT, HOST, () => {
  console.log(`TCP Server is definitely listening on port ${TCP_PORT}`);
});