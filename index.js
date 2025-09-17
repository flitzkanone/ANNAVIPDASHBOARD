const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;

// Diese Werte holen wir aus den Render Environment-Variablen
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;

// Einfacher Speicher für Nachrichten (wird bei jedem Neustart geleert)
let telegramMessages = [];

app.use(express.static('public'));
app.use(bodyParser.json());

// API-Endpunkt für die Render-Logs
app.get('/api/logs', async (req, res) => {
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
        res.status(500).send('Fehler beim Abrufen der Render-Logs.');
    }
});

// API-Endpunkt für die Telegram-Nachrichten
app.get('/api/telegram-messages', (req, res) => {
    res.json(telegramMessages);
});

// Webhook-Endpunkt, den Telegram aufruft
app.post(`/telegram/webhook`, (req, res) => {
    const message = req.body.message || req.body.channel_post;
    if (message && message.text) {
        const from = message.from ? message.from.first_name : message.chat.title;
        const newMessage = {
            user: from,
            text: message.text,
            timestamp: new Date(message.date * 1000).toLocaleString('de-DE')
        };
        telegramMessages.unshift(newMessage); // Neueste Nachricht nach vorne
        telegramMessages = telegramMessages.slice(0, 50); // Auf 50 Nachrichten begrenzen
    }
    res.sendStatus(200); // Telegram mitteilen, dass alles ok ist
});

app.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
