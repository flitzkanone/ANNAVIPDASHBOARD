const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;

// --- Render Environment-Variablen ---
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_CHAT_ID = process.env.DATABASE_CHAT_ID;
const DATABASE_MESSAGE_ID = process.env.DATABASE_MESSAGE_ID;

// In-Memory Speicher für unsere Daten
let dataStore = {
    rawMessages: [],
    users: {},
    actions: [],
    dailyUsage: {}
};

// --- Telegram als Datenbank ---
const telegramApi = axios.create({
    baseURL: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
});

async function loadDataFromTelegram() {
    console.log('Lade Daten aus Telegram...');
    if (!DATABASE_CHAT_ID || !DATABASE_MESSAGE_ID) {
        console.log('Datenbank-Variablen nicht gesetzt. Starte mit leerem Speicher.');
        return;
    }
    try {
        const response = await telegramApi.post('/forwardMessage', {
            chat_id: DATABASE_CHAT_ID,
            from_chat_id: DATABASE_CHAT_ID,
            message_id: DATABASE_MESSAGE_ID
        });
        
        const messageText = response.data.result.text;
        if (messageText && messageText.length > 2) {
            dataStore = JSON.parse(messageText);
            console.log('Daten erfolgreich aus Telegram geladen!');
        } else {
             console.log('Datenbank-Nachricht ist leer, starte mit leerem Speicher.');
             dataStore = { rawMessages: [], users: {}, actions: [], dailyUsage: {} };
        }
    } catch (error) {
        console.error('Fehler beim Laden der Daten aus Telegram. Starte mit leerem Speicher.');
        dataStore = { rawMessages: [], users: {}, actions: [], dailyUsage: {} };
    }
}

async function saveDataToTelegram() {
    console.log('Speichere Daten in Telegram...');
    if (!DATABASE_CHAT_ID || !DATABASE_MESSAGE_ID) return;
    try {
        const dataString = JSON.stringify(dataStore, null, 2);
        // Schutz vor dem Überschreiben mit leeren Daten bei einem Fehler
        if (dataString.length < 30) { 
            console.warn("Daten zum Speichern sind sehr kurz, überspringe das Speichern, um Datenverlust zu vermeiden.");
            return;
        }
        await telegramApi.post('/editMessageText', {
            chat_id: DATABASE_CHAT_ID,
            message_id: DATABASE_MESSAGE_ID,
            text: dataString,
            disable_web_page_preview: true
        });
        console.log('Daten erfolgreich in Telegram gespeichert.');
    } catch (error) {
        console.error('Fehler beim Speichern der Daten in Telegram:', error.response?.data);
    }
}

// --- App Konfiguration ---
app.use(express.static('public'));
app.use(bodyParser.json());

// --- API Endpunkte (unverändert) ---
app.get('/api/logs', async (req, res) => {
    // ... (unverändert)
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
        return res.status(500).send('Render API-Key oder Service-ID ist nicht konfiguriert.');
    }
    try {
        const response = await axios.get(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/logs?limit=100`, {
            headers: { 'Authorization': `Bearer ${RENDER_API_KEY}` }
        });
        const formattedLogs = response.data.map(logEntry => `${logEntry.log.timestamp} - ${logEntry.log.message}`).join('\n');
        res.type('text/plain').send(formattedLogs);
    } catch (error) {
        console.error('Fehlerdetails von der Render API:', error.response?.data || error.message);
        res.status(500).send('Fehler beim Abrufen der Render-Logs. Siehe Server-Logs für Details.');
    }
});
app.get('/api/stats', (req, res) => {
    // ... (unverändert)
    const actionCounts = { 5: 0, 10: 0, 15: 0, 25: 0, 30: 0 };
    dataStore.actions.forEach(action => {
        if (actionCounts[action.value] !== undefined) actionCounts[action.value]++;
    });
    const userList = Object.values(dataStore.users).map(u => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name));
    const userGrowth = {};
    for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateString = d.toISOString().split('T')[0];
        userGrowth[dateString] = dataStore.dailyUsage[dateString] || 0;
    }
    res.json({
        rawMessages: dataStore.rawMessages,
        stats: { actionCounts, userList, userGrowth }
    });
});

// --- Telegram Webhook (ANGEPASSTE LOGIK) ---
app.post(`/telegram/webhook`, (req, res) => {
    const message = req.body.message || req.body.channel_post;
    if (!message || !message.text) return res.sendStatus(200);

    const now = new Date();
    const text = message.text;

    // Speichere jede Nachricht im Live-Feed
    dataStore.rawMessages.unshift({
        user: message.from ? message.from.first_name : message.chat.title,
        text: text,
        timestamp: new Date(message.date * 1000).toLocaleString('de-DE')
    });
    dataStore.rawMessages = dataStore.rawMessages.slice(0, 50);
    
    // --- NEUE PARSING-LOGIK ---
    // Wir verwenden reguläre Ausdrücke, um die Teile aus der Nachricht zu extrahieren.
    const userMatch = text.match(/ID: (\d+)\nName: (.*)/);
    const actionMatch = text.match(/Aktion: .*? für (\d+)€/);

    // Wir verarbeiten nur, wenn wir BEIDE Teile finden.
    if (userMatch && actionMatch) {
        // 1. Nutzerdaten extrahieren und verarbeiten
        const id = userMatch[1].trim();
        const name = userMatch[2].trim();
        const today = now.toISOString().split('T')[0];
        const user = dataStore.users[id];
        const oneDay = 24 * 60 * 60 * 1000;

        // Tägliche Nutzerstatistik aktualisieren (nur einmal alle 24h pro Nutzer)
        if (!user || (now - new Date(user.lastLogin)) > oneDay) {
            dataStore.dailyUsage[today] = (dataStore.dailyUsage[today] || 0) + 1;
        }
        // Nutzer in die Liste eintragen/aktualisieren
        dataStore.users[id] = { id, name, lastLogin: now.toISOString() };

        // 2. Aktionsdaten extrahieren und verarbeiten
        const value = parseInt(actionMatch[1], 10);
        dataStore.actions.push({ value: value, timestamp: now.toISOString() });
        
        console.log(`Verarbeitet: Nutzer ${name} (ID: ${id}) mit Aktion ${value}€`);
    }

    res.sendStatus(200); // Wichtig: Telegram sofort antworten.

    // Das Speichern wird wie zuvor verzögert ausgelöst.
    clearTimeout(global.saveTimeout);
    global.saveTimeout = setTimeout(saveDataToTelegram, 10000);
});

// --- Server Start ---
app.listen(PORT, async () => {
    await loadDataFromTelegram();
    console.log(`Server läuft auf Port ${PORT}`);
    setInterval(saveDataToTelegram, 5 * 60 * 1000); 
});
