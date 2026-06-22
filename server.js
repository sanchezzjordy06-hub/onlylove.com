/* ============================================================
   ONLY LOVE — BACKEND DE VERIFICACIÓN DE CORREO
   ============================================================
   Este servidor:
   1) Genera un código de 6 dígitos
   2) Lo envía al correo del usuario usando Resend
   3) Guarda el código temporalmente en memoria (con expiración)
   4) Valida el código que el usuario ingresa en la app

   ⚠️ NOTA IMPORTANTE SOBRE EL ALMACENAMIENTO:
   Aquí los códigos se guardan en un Map en memoria, lo cual es
   válido para pruebas o un MVP pequeño. Si despliegas esto en
   producción con varias instancias del servidor, o si el servidor
   se reinicia, los códigos se pierden. Para producción real,
   usa una base de datos (Redis, PostgreSQL, etc.) en su lugar.
============================================================ */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

const PORT = process.env.PORT || 3000;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Only Love <onboarding@resend.dev>';
const CODE_TTL_MS = 10 * 60 * 1000; // El código expira a los 10 minutos
const RESEND_COOLDOWN_MS = 30 * 1000; // 30s entre reenvíos para evitar abuso

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));

// Almacén temporal en memoria: email -> { code, expiresAt, lastSentAt, attempts }
const verificationStore = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ============================================================
   POST /api/send-verification
   Body: { email: string }
   Genera un código, lo guarda y lo envía por correo.
============================================================ */
app.post('/api/send-verification', async (req, res) => {
  const { email } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Correo inválido.' });
  }

  const existing = verificationStore.get(email);
  if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    return res.status(429).json({ ok: false, error: `Espera ${waitSec}s antes de reenviar.` });
  }

  const code = generateCode();
  verificationStore.set(email, {
    code,
    expiresAt: Date.now() + CODE_TTL_MS,
    lastSentAt: Date.now(),
    attempts: 0,
  });

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Tu código de verificación — Only Love',
      html: `
        <div style="font-family:sans-serif;max-width:420px;margin:0 auto">
          <h2 style="color:#8A142C">Only Love</h2>
          <p>Tu código de verificación es:</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#8A142C">${code}</p>
          <p style="color:#666;font-size:13px">Este código vence en 10 minutos. Si no solicitaste este código, ignora este correo.</p>
        </div>
      `,
    });

    return res.json({ ok: true, message: 'Código enviado correctamente.' });
  } catch (err) {
    console.error('Error al enviar correo con Resend:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo enviar el correo. Intenta de nuevo.' });
  }
});

/* ============================================================
   POST /api/verify-email
   Body: { email: string, code: string }
   Valida el código ingresado por el usuario.
============================================================ */
app.post('/api/verify-email', (req, res) => {
  const { email, code } = req.body;

  if (!isValidEmail(email) || !code) {
    return res.status(400).json({ ok: false, valid: false, error: 'Datos incompletos.' });
  }

  const record = verificationStore.get(email);

  if (!record) {
    return res.status(400).json({ ok: false, valid: false, error: 'No hay un código pendiente para este correo. Solicita uno nuevo.' });
  }

  if (Date.now() > record.expiresAt) {
    verificationStore.delete(email);
    return res.status(400).json({ ok: false, valid: false, error: 'El código expiró. Solicita uno nuevo.' });
  }

  record.attempts += 1;
  if (record.attempts > 5) {
    verificationStore.delete(email);
    return res.status(429).json({ ok: false, valid: false, error: 'Demasiados intentos. Solicita un nuevo código.' });
  }

  if (record.code !== String(code).trim()) {
    return res.status(400).json({ ok: false, valid: false, error: 'Código incorrecto.' });
  }

  verificationStore.delete(email); // Código usado, se elimina
  return res.json({ ok: true, valid: true, message: 'Correo verificado correctamente.' });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Backend de Only Love corriendo en http://localhost:${PORT}`);
});
