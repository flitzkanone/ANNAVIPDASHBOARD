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
        // Wir können die Nachricht nicht direkt lesen, aber wir leiten sie an uns selbst weiter, um den Inhalt zu bekommen.
        // Ein kleiner Trick, da getMessage nicht direkt den Text liefert.
        const response = await telegramApi.post('/forwardMessage', {
            chat_id: DATABASE_CHAT_ID,
            from_chat_id: DATABASE_CHAT_ID,
            message_id: DATABASE_MESSAGE_ID
        });
        
        const messageText = response.data.result.text;
        if (messageText) {
            dataStore = JSON.parse(messageText);
            console.log('Daten erfolgreich aus Telegram geladen!');
        }
    } catch (error) {
        console.error('Fehler beim Laden der Daten aus Telegram. Starte mit leerem Speicher.', error.response?.data);
        // Initialisiere mit leerem Store, falls die Nachricht leer oder fehlerhaft ist.
        dataStore = { rawMessages: [], users: {}, actions: [], dailyUsage: {} };
    }
}

async function saveDataToTelegram() {
    console.log('Speichere Daten in Telegram...');
    if (!DATABASE_CHAT_ID || !DATABASE_MESSAGE_ID) return;
    try {
        const dataString = JSON.stringify(dataStore, null, 2);
        await telegramApi.post('/editMessageText', {
            chat_id: DATABASE_CHAT_ID,
            message_id: DATABASE_MESSAGE_ID,
            text: dataString,
            // Deaktiviere Link-Vorschau
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

// --- API Endpunkte (bleiben fast gleich, greifen nur auf dataStore zu) ---
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
    // Statistik 1: Aktionen nach Betrag
    const actionCounts = { 5: 0, 10: 0, 15: 0, 25: 0, 30: 0 };
    dataStore.actions.forEach(action => {
        if (actionCounts[action.value] !== undefined) actionCounts[action.value]++;
    });

    // Statistik 2: Nutzerliste
    const userList = Object.values(dataStore.users).map(u => ({ id: u.id, name: u.name }));

    // Statistik 3: Nutzer pro Tag
    const userGrowth = {};
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateString = d.toISOString().split('T')[0];
        userGrowth[dateString] = dataStore.dailyUsage[dateString] || 0;
    }
    
    res.json({
        rawMessages: dataStore.rawMessages,
        stats: { actionCounts, userList, userGrowth }
    });
});


// --- Telegram Webhook (Kernlogik) ---
app.post(`/telegram/webhook`, (req, res) => {
    const message = req.body.message || req.body.channel_post;
    if (!message || !message.text) return res.sendStatus(200);

    const now = new Date();
    const text = message.text;

    // 1. Raw Message speichern
    dataStore.rawMessages.unshift({
        user: message.from ? message.from.first_name : message.chat.title,
        text: text,
        timestamp: new Date(message.date * 1000).toLocaleString('de-DE')
    });
    dataStore.rawMessages = dataStore.rawMessages.slice(0, 50);
    
    // 2. Nachrichten parsen
    const newUserMatch = text.match(/🎉Neuer Nutzer gestartet!\nID: (.*)\nName: (.*)/);
    const actionMatch = text.match(/Aktion: (?:🎟️Gutschein|💰 Paypal|🪙 Krypto) für (\d+)€/);

    if (newUserMatch) {
        const id = newUserMatch[1].trim();
        const name = newUserMatch[2].trim();
        const today = now.toISOString().split('T')[0];
        const user = dataStore.users[id];
        const oneDay = 24 * 60 * 60 * 1000;

        if (!user || (now - new Date(user.lastLogin)) > oneDay) {
            dataStore.dailyUsage[today] = (dataStore.dailyUsage[today] || 0) + 1;
        }
        dataStore.users[id] = { id, name, lastLogin: now.toISOString() };

    } else if (actionMatch) {
        const value = parseInt(actionMatch[1], 10);
        dataStore.actions.push({ value: value, timestamp: now.toISOString() });
    }
    
    // Wichtig: Wir bestätigen Telegram sofort, dass die Nachricht ankam.
    res.sendStatus(200);

    // Das Speichern passiert *nachdem* wir Telegram geantwortet haben, um Timeouts zu vermeiden.
    // Wir speichern nicht bei jeder Nachricht, um die API nicht zu überlasten (Debouncing).
    // Setze einen Timer, um in 10 Sekunden zu speichern. Wenn eine neue Nachricht kommt, wird der alte Timer gelöscht.
    clearTimeout(global.saveTimeout);
    global.saveTimeout = setTimeout(saveDataToTelegram, 10000); // 10 Sekunden warten
});


// --- Server Start ---
app.listen(PORT, async () => {
    await loadDataFromTelegram();
    console.log(`Server läuft auf Port ${PORT}`);
    
    // Speichere alle 5 Minuten, falls keine neuen Nachrichten kommen
    setInterval(saveDataToTelegram, 5 * 60 * 1000); 
});
