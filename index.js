const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
const { DateTime } = require('luxon');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();
const fs = require('fs');

const {
  ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN,
  DF_PROJECT_ID,
  GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64,
  GOOGLE_SHEETS_CREDENTIALS_BASE64,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  GOOGLE_SHEETS_ID
} = process.env;

console.log("🧪 Variáveis de ambiente carregadas:", {
  ZAPI_INSTANCE_ID,
  ZAPI_INSTANCE_TOKEN: !!ZAPI_INSTANCE_TOKEN,
  ZAPI_CLIENT_TOKEN: !!ZAPI_CLIENT_TOKEN,
  DF_PROJECT_ID,
  TELEGRAM_BOT_TOKEN: !!TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: !!TELEGRAM_CHAT_ID,
  GOOGLE_SHEETS_ID: !!GOOGLE_SHEETS_ID
});

if (!ZAPI_INSTANCE_ID || !ZAPI_INSTANCE_TOKEN || !ZAPI_CLIENT_TOKEN || !DF_PROJECT_ID || !GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64 || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !GOOGLE_SHEETS_ID) {
  console.error("❌ ERRO: Variáveis de ambiente obrigatórias não definidas!");
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

let dialogflowAuthClient = null;
let sheetsAuthClient = null;
let accessToken = null;
let tokenExpiry = 0;

// 🔐 Autenticação Dialogflow
async function getDialogflowAccessToken() {
  if (!dialogflowAuthClient) {
    const credentials = JSON.parse(Buffer.from(GOOGLE_DIALOGFLOW_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/dialogflow']
    });
    dialogflowAuthClient = await auth.getClient();
  }

  const tokenResponse = await dialogflowAuthClient.getAccessToken();
  accessToken = tokenResponse.token;
  tokenExpiry = Date.now() + 50 * 60 * 1000;
}

// 🔐 Autenticação Google Calendar
let calendarAuthClient = null;
async function getCalendarAuthClient() {
  if (!calendarAuthClient) {
    const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_CALENDAR_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    calendarAuthClient = await auth.getClient();
  }
  return calendarAuthClient;
}

// 🔐 Autenticação Google Sheets
async function getSheetsAuthClient() {
  if (!sheetsAuthClient) {
    const credentials = JSON.parse(Buffer.from(GOOGLE_SHEETS_CREDENTIALS_BASE64, 'base64').toString('utf8'));
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    sheetsAuthClient = await auth.getClient();
  }
  return sheetsAuthClient;
}

// Verifica se as abas existem e cria se não existirem
async function ensureSheetTabsExist() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEETS_ID });

    const existingTabs = metadata.data.sheets.map(s => s.properties.title);
    const requiredTabs = ['Atendimentos', 'Agendamentos'];

    const tabsToCreate = requiredTabs.filter(tab => !existingTabs.includes(tab));

    if (tabsToCreate.length > 0) {
      const requests = tabsToCreate.map(title => ({
        addSheet: { properties: { title } }
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEETS_ID,
        requestBody: { requests }
      });

      tabsToCreate.forEach(tab => {
        console.log(`✅ Aba '${tab}' criada automaticamente.`);
      });
    }
  } catch (err) {
    console.error("❌ Erro ao verificar/criar abas da planilha:", err.message);
  }
}

// Registros de atendimentos no Sheets
async function logToSheet({ phone, message, type, intent }) {
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Buenos_Aires' });
    const sheetName = 'Atendimentos';

    await ensureSheetTabsExist(sheetName);
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetName}!A:E`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[now, phone, message, type, intent || '']]
      }
    });
  } catch (err) {
    console.error("❌ Falha ao registrar no Google Sheets:", err.message);
  }
}

// Registros de agendamentos(avaliação/consulta) no Sheets
async function logToAgendamentosSheet({ nome, telefone, tipoAgendamento, data, hora, procedimento, convenio = '-' }) {
  console.log("🧾 Dados a serem salvos:", {
    nome, telefone, tipoAgendamento, data, hora, procedimento, convenio
  });
  try {
    const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
    const sheetName = 'Agendamentos';
    await ensureSheetTabsExist();

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${sheetName}!A:G`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[nome, telefone, tipoAgendamento, data, hora, procedimento, convenio]]
      }
    });

    console.log(`📆 Agendamento registrado com sucesso: ${nome}, ${data} às ${hora}, ${procedimento}, convênio: ${convenio}`);
  } catch (err) {
    console.error("❌ Erro ao registrar agendamento no Google Sheets:", err.message);
  }
}

// 📆 Função para confirmar agendamento
async function confirmarAgendamento({ nome, telefone, dataISO, hora, tipoAgendamento, procedimento, dataFormatada }) {
  await criarEventoGoogleCalendar({
    nome,
    telefone,
    dataISO,
    hora,
    tipoAgendamento,
    procedimento
  });
  await logToAgendamentosSheet({
    nome,
    telefone,
    tipoAgendamento,
    data: dataFormatada,
    hora,
    procedimento
  });

  await sendZapiMessage(`Perfeito, ${nome}! Sua ${tipoAgendamento} para *${procedimento}* está agendada para *${dataFormatada}* às *${hora}*. Até lá! 🩵`);
}

// 📆 Função para consultar horários disponíveis do Google Calendar
async function listarHorariosDisponiveis(dateISO) {
  const auth = await getCalendarAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const date = new Date(dateISO);
  const diaSemana = date.getDay();

  // Regras de horário
  const horariosBase = {
    weekday: Array.from({ length: 20 }, (_, i) => {
      const h = 8 + Math.floor(i / 2);
      const m = i % 2 === 0 ? '00' : '30';
      return `${String(h).padStart(2, '0')}:${m}`;
    }),
    saturday: ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'],
    sunday: []
  };

  let horariosPossiveis;
  if (diaSemana === 6) horariosPossiveis = horariosBase.saturday;
  else if (diaSemana === 0) return []; // domingo
  else horariosPossiveis = horariosBase.weekday;

  const startOfDay = DateTime.fromISO(dateISO, { zone: 'America/Buenos_Aires' }).startOf('day').toISO();
  const endOfDay = DateTime.fromISO(dateISO, { zone: 'America/Buenos_Aires' }).endOf('day').toISO();

  const events = await calendar.events.list({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeMin: startOfDay,
    timeMax: endOfDay,
    singleEvents: true,
    orderBy: 'startTime'
  });

  const eventos = events.data.items || [];
  const horariosOcupados = eventos.map(e => {
    const hora = new Date(e.start.dateTime).toTimeString().slice(0, 5);
    return hora;
  });

  const horariosDisponiveis = horariosPossiveis.filter(h => !horariosOcupados.includes(h));
  return horariosDisponiveis;
}

// 📆 Função para agendamento no Google Calendar
async function criarEventoGoogleCalendar({ nome, telefone, dataISO, hora, tipoAgendamento, procedimento }) {
  try {
    console.log('📤 Preparando agendamento no Google Calendar...');
    console.log('📌 Dados recebidos:', { nome, telefone, dataISO, hora, tipoAgendamento, procedimento });

    const auth = await getCalendarAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // ✅ Usa Luxon para combinar data + hora com timezone
    const start = DateTime.fromISO(`${dataISO}T${hora}`, { zone: 'America/Buenos_Aires' });
    const end = start.plus({ minutes: 30 }); // duração 30 min

    if (!nome || !telefone || !dataISO || !hora) {
      console.error('❌ Dados incompletos para criar o evento no Google Calendar:', { nome, telefone, dataISO, hora });
      throw new Error('Dados incompletos para criar o evento no Google Calendar.');
    }

    // ✅ Evento a ser enviado
    const evento = {
      summary: `${tipoAgendamento.toUpperCase()} - ${nome}`,
      description: `Procedimento: ${procedimento}\nTelefone: ${telefone}`,
      start: { dateTime: start.toISO(), timeZone: 'America/Buenos_Aires' },
      end: { dateTime: end.toISO(), timeZone: 'America/Buenos_Aires' },
    };

    // ✅ Logs para debug
    console.log('📨 Evento a ser enviado:', JSON.stringify(evento, null, 2));
    console.log("📅 Horário agendado:", {
      data: dataISO,
      hora,
      start: start.toISO(),
      end: end.toISO()
    });

    // ✅ Criação do evento no Google Calendar
    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: evento
    });

    console.log('✅ Evento criado com sucesso no Google Calendar');
    console.log('🔗 Link do evento:', response.data.htmlLink);

    return response;
  } catch (error) {
    console.error('❌ Erro ao criar evento no Google Calendar:', error.message);
    throw error;
  }
}

// Função para buscar os parâmetros em qualquer contexto ativo
function getParametroDosContextos(contexts, parametro) {
  for (const ctx of contexts) {
    if (ctx.parameters && ctx.parameters[parametro] !== undefined) {
      return ctx.parameters[parametro];
    }
  }
  return undefined;
}

// Notifica Telegram
async function notifyTelegram(phone, message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `📞 *Novo pedido de atendimento humano*\n*Telefone:* ${phone}\n💬 *Mensagem:* ${message}`;
  const buttons = {
    inline_keyboard: [
      [{ text: "📲 Ver conversa no WhatsApp", url: `https://wa.me/${phone}` }],
      [{ text: '✅ Marcar como resolvido', callback_data: `resolve:${phone}` }],
      [{ text: '🕓 Ver mensagens recentes', callback_data: `historico:${phone}` }]
    ]
  };
  return axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
    reply_markup: buttons
  });
}

// Extrai campos de fallback da mensagem caso o Dialogflow não consiga extrair os parâmetros
function extractFallbackFields(message) {
  const rawText = message?.text?.message || '';
  const texto = rawText.replace(/\s+/g, ' ').trim();
  // Expressões regulares
  const dataRegex = /(\d{1,2})[\/\-](\d{1,2})/;
  const horaRegex = /\b(\d{1,2})\s*[h:]\s*(\d{0,2})\b/;

  let nome = '';
  let data = '';
  let hora = '';
  let procedimento = '';

  // === Data ===
  const dataMatch = texto.match(dataRegex);
  let dataIndex = -1;
  if (dataMatch) {
    const [_, diaStr, mesStr] = dataMatch;
    const dia = parseInt(diaStr, 10);
    const mes = parseInt(mesStr, 10);
    const hoje = new Date();
    let ano = hoje.getFullYear();
    const dataTentativa = new Date(ano, mes - 1, dia);
    if (dataTentativa < hoje.setHours(0, 0, 0, 0)) ano += 1;

    data = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}T00:00:00-03:00`;
    dataIndex = dataMatch.index ?? -1;
  }
  // === Hora ===
  const horaMatch = texto.match(horaRegex);
  let horaIndex = -1;
  if (horaMatch) {
    const h = parseInt(horaMatch[1], 10);
    const m = horaMatch[2] ? parseInt(horaMatch[2], 10) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      hora = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      horaIndex = horaMatch.index ?? -1;
    }
  }
  // === Nome ===
  const corte = Math.min(...[dataIndex, horaIndex].filter(i => i >= 0));
  const nomeCompleto = corte !== Infinity ? texto.slice(0, corte).trim() : texto;
  nome = nomeCompleto.split(/\s+/).slice(0, 4).join(' ');
  // === Procedimento ===
  if (horaIndex >= 0) {
    const depoisDaHora = texto.slice(horaIndex + horaMatch[0].length).trim();
    procedimento = depoisDaHora.split(/\s+/).slice(0, 5).join(' ');
  }
  return { nome, data, hora, procedimento };
}

// Formata data e hora
function formatarDataHora(valor, tipo) {
  const { DateTime } = require('luxon');

  if (typeof valor !== 'string') return '';

  valor = valor.normalize("NFKD").replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!valor) return tipo === 'data' ? 'Data inválida' : '';

  try {
    if (tipo === 'hora') {
      // 🕓 Tenta capturar formato ISO tipo '2025-06-14T22:30:00-03:00'
      const isoMatch = valor.match(/T(\d{2}):(\d{2}):/);
      if (isoMatch) {
        const [, hour, minute] = isoMatch;
        return `${hour}:${minute}`;
      }

      // 🕓 Verifica formatos simples (10:30, 10h30, etc)
      const horaRegexes = [
        /^(\d{1,2})h(\d{1,2})$/,   // 10h30
        /^(\d{1,2})h$/,            // 10h
        /^(\d{1,2}):(\d{1,2})$/,   // 10:30
        /^(\d{1,2}):(\d{1,2})h$/,  // 10:30h
        /^(\d{2})(\d{2})$/,        // 1030
        /^(\d{1,2})$/              // 10
      ];

      for (const regex of horaRegexes) {
        const match = valor.match(regex);
        if (match) {
          const horas = match[1].padStart(2, '0');
          const minutos = (match[2] || '00').padStart(2, '0');

          const h = parseInt(horas, 10);
          const m = parseInt(minutos, 10);

          if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
            return `${horas}:${minutos}`;
          }
        }
      }

      return 'Hora inválida';
    }

    if (tipo === 'data') {
      const formatos = [
        { regex: /^\d{4}-\d{2}-\d{2}$/, ordem: ['ano', 'mes', 'dia'] },
        { regex: /^\d{2}\/\d{2}\/\d{4}$/, ordem: ['dia', 'mes', 'ano'] },
        { regex: /^\d{2}-\d{2}-\d{4}$/, ordem: ['dia', 'mes', 'ano'] },
        { regex: /^\d{4}\/\d{2}\/\d{2}$/, ordem: ['ano', 'mes', 'dia'] },
      ];

      for (const formato of formatos) {
        if (formato.regex.test(valor)) {
          const partes = valor.split(/[-/]/).map(Number);
          const { dia, mes, ano } = {
            dia: partes[formato.ordem.indexOf('dia')],
            mes: partes[formato.ordem.indexOf('mes')],
            ano: partes[formato.ordem.indexOf('ano')],
          };

          const dt = DateTime.fromObject({ day: dia, month: mes, year: ano });
          if (dt.isValid) {
            return dt.toFormat('dd/MM/yyyy');
          }
          return 'Data inválida';
        }
      }

      // === Verifica se é um ISO Date ===
      const dt = DateTime.fromISO(valor, { zone: 'America/Buenos_Aires' });
      if (dt.isValid) {
        return dt.toFormat('dd/MM/yyyy');
      }

      return 'Data inválida';
    }

    return '';
  } catch (error) {
    console.error("❌ Erro ao formatar data/hora:", error);
    return tipo === 'data' ? 'Data inválida' : 'Hora inválida';
  }
}

// Função para extrair hora de forma segura
function extrairHoraSeguro(parameters, message) {
  const rawMessage = message?.text?.message || '';

  // 🥇 prioridade total para o valor digitado pelo usuário
  const horaOriginal = parameters?.['hora.original'];
  if (horaOriginal && typeof horaOriginal === 'string') {
    const h = formatarDataHora(horaOriginal, 'hora');
    if (h && h !== 'Hora inválida') return h;
  }

  // 🥈 fallback para ISO: '2025-06-14T22:30:00-03:00'
  const horaConvertida = parameters?.hora;
  if (horaConvertida && typeof horaConvertida === 'string') {
    const h2 = formatarDataHora(horaConvertida, 'hora');
    if (h2 && h2 !== 'Hora inválida') return h2;
  }

  // 🥉 fallback final: regex na mensagem do usuário
  const regex = /(\d{1,2})[:h]?(\d{2})?/;
  const match = rawMessage.match(regex);
  if (match) {
    const h = match[1].padStart(2, '0');
    const m = match[2] ? match[2].padStart(2, '0') : '00';
    if (parseInt(h) < 24 && parseInt(m) < 60) {
      return `${h}:${m}`;
    }
  }

  return null;
}

// Função para capitalizar a primeira letra de cada palavra
function capitalizarNomeCompleto(nome) {
  if (!nome || typeof nome !== 'string') return '';

  // Normaliza espaços
  nome = nome.trim().replace(/\s+/g, ' ');

  // Capitaliza cada palavra do nome
  return nome
    .split(' ')
    .map(palavra =>
      palavra
        .split(/(['-])/g) // separa mantendo hífen e apóstrofo como delimitadores
        .map(parte =>
          parte === '-' || parte === "'"
            ? parte // mantém hífen ou apóstrofo como está
            : parte.charAt(0).toUpperCase() + parte.slice(1).toLowerCase()
        )
        .join('')
    )
    .join(' ');
}

// Função para extrair convenio em frases
function detectarConvenioNaFrase(frase, listaConvenios) {
  const normalizar = (str) =>
    str.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();

  const normalizadaFrase = normalizar(frase);

  console.log("🔎 Buscando convênio:", normalizadaFrase);

  // Mapeia lista com objetos { original, normalizado }
  const listaNormalizada = listaConvenios.map(c => ({
    original: c,
    normalizado: normalizar(c)
  }));

  listaNormalizada.forEach(c => console.log("-", c.normalizado));

  const detectado = listaNormalizada.find(({ normalizado }) =>
    normalizadaFrase.includes(normalizado)
  );

  return detectado?.original; // retorna o nome original do convênio, se encontrado
}

// Função para primeira letra maiúscula
function toTitleCase(str) {
  return str.replace(/\w\S*/g, (txt) =>
    txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
  );
}

//Funções para urgencia
function getContext(queryResult, contextName) {
  return queryResult?.outputContexts?.find(c => c.name.includes(contextName));
}
function setContext(res, name, lifespan = 2, parameters = {}, sessionId) {
  const outputContexts = [
    {
      name: `projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}/contexts/${name}`,
      lifespanCount: lifespan,
      parameters
    }
  ];
  res.locals.outputContexts = outputContexts;
}

// Lê o arquivo convenios.json e armazena os convênios aceitos
let conveniosAceitos = []; // Agora é mutável
try {
  const data = fs.readFileSync('./data/convenios.json', 'utf8');
  const parsedData = JSON.parse(data);

  if (!Array.isArray(parsedData.convenios)) {
    throw new Error("Arquivo JSON não possui um array 'convenios'");
  }

  // Convertendo todos para lowercase e removendo espaços extras
  conveniosAceitos = parsedData.convenios.map(c => c.toLowerCase().trim());
  console.log("✅ Convênios carregados:", conveniosAceitos.length);
} catch (err) {
  console.error("❌ Erro ao ler ou processar o arquivo convenios.json:", err.message);
}


// Rota do webhook da Z-API
app.post('/zapi-webhook', async (req, res) => {
  console.log('📥 Mensagem recebida da Z-API:', req.body);
  if (
    req.body.isNewsletter ||
    String(req.body.phone).includes('@newsletter') ||
    req.body.isGroup ||
    req.body.type !== 'ReceivedCallback'
  ) return res.status(200).send("Ignorado");

  const from = req.body.phone;
  const message = req.body.text?.message || '';
  const sessionId = `session-${from}`;
  const cleanPhone = String(from).replace(/\D/g, '');

  const normalize = (text) =>
    text.toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9 ]+/g, "")
      .trim();

  if (!from || !message) return res.status(400).send('Dados inválidos');

  await logToSheet({
    phone: cleanPhone,
    message,
    type: 'usuario'
  });

  try {
    if (!accessToken || Date.now() >= tokenExpiry) await getDialogflowAccessToken();

    const dialogflowResponse = await axios.post(
      `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
      { queryInput: { text: { text: message, languageCode: 'pt-BR' } } },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const queryResult = dialogflowResponse.data.queryResult;
    const reply = queryResult?.fulfillmentText?.trim();
    console.log("🤖 Resposta do bot:", reply);
    const intent = queryResult?.intent?.displayName;
    const parameters = queryResult?.parameters || {};
    const outputContexts = queryResult?.outputContexts || [];

    console.log("🔍 Contextos ativos:", queryResult.outputContexts);
    console.log("🧠 Intent recebida:", intent);
    console.log("📦 Parâmetros recebidos:", parameters);
    console.log("🔍 Contextos ativos:", outputContexts);

    const sendZapiMessage = async (text) => {
      return axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: text
      }, {
        headers: { 'Client-Token': ZAPI_CLIENT_TOKEN }
      });
    };

    // 📆 Função genérica para lidar com agendamento, interrompendo se horário estiver ocupado
    const handleAgendamento = async (tipoAgendamento, cleanPhone) => {
      try {
        const fallback = extractFallbackFields(message);
        const rawMessage = message?.text?.message || '';

        // 🧠 Nome
        const nomeRaw = parameters?.nome
          || (Array.isArray(parameters?.nome) ? parameters.nome.join(' ') : parameters?.nome)
          || fallback.nome
          || 'Cliente';

        const nome = capitalizarNomeCompleto(
          nomeRaw.trim().split(/\s+/).slice(0, 4).join(' ')
        );

        // 🩺 Procedimento
        const procedimento = parameters?.procedimento || fallback.procedimento || 'procedimento a ser analisado';

        // 📅 Data
        const dataParam = parameters?.data || fallback.data;
        const dt = DateTime.fromISO(dataParam, { zone: 'America/Sao_Paulo' });
        const dataISO = dt.isValid ? dt.toFormat('yyyy-MM-dd') : null;

        if (!dataISO) {
          await sendZapiMessage("❌ Não entendi a data informada. Por favor, envie no formato *DD/MM*. Exemplo: *02/10*");
          return;
        }

        const dataFormatada = formatarDataHora(dataISO, 'data');

        // 🕒 Hora 
        const horaRaw =
          parameters?.['hora.original'] ||
          extractFallbackFields(message).hora ||
          '';

        const hora = extrairHoraSeguro(parameters, message);

        console.log("🕓 Hora interpretada:", hora, "| Valor original:", horaRaw);

        if (!hora || hora === 'Hora inválida') {
          await sendZapiMessage("❌ Não entendi o horário. Envie no formato *HH:mm*, como 09:30");
          return;
        }

        // 🔍 Convênio
        const contextoConvenio = queryResult.outputContexts?.find(ctx =>
          ctx.parameters?.convenio || ctx.parameters?.convenio_detectado
        );
        const convenio = contextoConvenio?.parameters?.convenio ||
          contextoConvenio?.parameters?.convenio_detectado || '-';

        // ⏳ Verifica disponibilidade
        const horariosDisponiveis = await listarHorariosDisponiveis(dataISO);

        if (!horariosDisponiveis.includes(hora)) {
          const ctxNome = getContext(queryResult, 'aguardando_nome');
          const tipoAg = tipoAgendamento || ctxNome?.parameters?.tipoAgendamento || 'consulta';

          await setContext(res, 'aguardando_horario_disponivel', 3, {
            nome,
            telefone: cleanPhone,
            dataISO,
            tipoAgendamento: tipoAg,
            procedimento
          }, sessionId);

          await sendZapiMessage(
            `⚠️ Esse horário também está ocupado.\nEscolha um destes disponíveis:\n\n\`\`\`${horariosDisponiveis.join(' | ')}\`\`\``
          );
          return;
        }

        // ✅ Tudo certo — confirma agendamento
        await confirmarAgendamento({
          nome,
          telefone: cleanPhone,
          dataISO,
          hora,
          tipoAgendamento,
          procedimento,
          dataFormatada
        });

      } catch (err) {
        console.error("❌ Erro no agendamento:", err.message);
        await sendZapiMessage("Tivemos um problema ao concluir o agendamento. Tente novamente.");
      }
    };

    // Identifica quando o usuário respondeu "sim" e está no contexto certo (consulta ou avaliação)
    if (normalize(message) === 'sim') {
      const contextNames = queryResult.outputContexts?.map(c => c.name) || [];

      const inConsultaContext = contextNames.some(name => name.includes('aguardando-sim-consulta'));
      const inAvaliacaoContext = contextNames.some(name => name.includes('aguardando-sim-avaliacao'));

      if (inConsultaContext) {
        console.log('📌 Direcionando para AgendarConsultaFinal');
        await handleAgendamento('consulta');
        return res.status(200).send("Agendamento de consulta realizado");
      }

      if (inAvaliacaoContext) {
        console.log('📌 Direcionando para AgendarAvaliacaoFinal');
        await handleAgendamento('avaliação');
        return res.status(200).send("Agendamento de avaliação realizado");
      }
    }

    if (intent === 'AgendarAvaliacao') {
      await setContext(res, 'aguardando_nome', 3, {
        tipoAgendamento: 'avaliação',
        telefone: cleanPhone
      }, sessionId);

      await sendZapiMessage("Claro 😊 Vou te ajudar a agendar uma avaliação. Me informe:\n➡️ Seu *nome*");
      return res.status(200).send("Aguardando nome");
    }

    if (intent === 'AgendarConsulta') {
      await setContext(res, 'aguardando_nome', 3, {
        tipoAgendamento: 'consulta',
        telefone: cleanPhone
      }, sessionId);

      await sendZapiMessage("Claro 😊 Vou te ajudar a agendar sua consulta. Me informe:\n➡️ Seu *nome*");
      return res.status(200).send("Aguardando nome");
    }

    if (intent === 'CapturarNome') {
      const nome = capitalizarNomeCompleto(parameters?.nome || contextParameters?.nome || fallback.nome || '');

      if (!nome) {
        await sendZapiMessage("❌ Não entendi seu nome. Pode informar novamente, por favor?");
        return res.status(200).send("Nome inválido");
      }

      const ctx = getContext(queryResult, 'aguardando_nome');

      await setContext(res, 'aguardando_data', 3, {
        ...ctx.parameters,
        telefone: cleanPhone,
        tipoAgendamento: ctx.parameters?.tipoAgendamento || 'agendamento a ser analisado',
        nome
      }, sessionId);

      await sendZapiMessage(`Legal, ${nome}! Agora me diga a *data* que deseja agendar. \n(exemplo: 05/08)`);
      return res.status(200).send("Aguardando data");
    }

    if (intent === 'CapturarData') {
      const { DateTime } = require('luxon');

      // Recupera parâmetros do contexto 'aguardando_data'
      const ctx = getContext(queryResult, 'aguardando_data');

      // Tenta obter a data ISO (yyyy-MM-dd) a partir dos parâmetros
      const dataISO = (() => {
        const dateParam = parameters?.data || fallback.data;
        if (!dateParam) return null;
        const dt = DateTime.fromISO(dateParam, { zone: 'America/Buenos_Aires' });
        return dt.isValid ? dt.toFormat('yyyy-MM-dd') : null;
      })();

      // Se não conseguir interpretar a data
      if (!dataISO) {
        await sendZapiMessage("❌ Não entendi a data. Pode informar no formato *DD/MM*?");
        return res.status(200).send("Data inválida");
      }

      // Consulta os horários disponíveis para a data informada
      const horarios = await listarHorariosDisponiveis(dataISO);

      // Se não houver horários disponíveis
      if (!horarios.length) {
        await sendZapiMessage("😕 Ops! Não há horários disponíveis nessa data. Pode informar outra?");
        return res.status(200).send("Sem horários disponíveis");
      }

      // Atualiza contexto aguardando_horario_disponivel com a nova data
      await setContext(res, 'aguardando_horario_disponivel', 3, {
        ...ctx.parameters,
        telefone: cleanPhone,
        tipoAgendamento: ctx.parameters?.tipoAgendamento || 'agendamento a ser analisado',
        nome: ctx.parameters?.nome || 'Paciente',
        dataISO: dataISO,
        dataFormatada: dataISO ? formatarDataHora(dataISO, 'data') : null
      }, sessionId);

      // Envia mensagem com horários disponíveis formatados (3 por linha)
      const horariosFormatados = horarios.reduce((linhas, horario, index) => {
        const linhaIndex = Math.floor(index / 3);
        if (!linhas[linhaIndex]) linhas[linhaIndex] = [];
        linhas[linhaIndex].push(horario);
        return linhas;
      }, []).map(linha => linha.join(' | ')).join('\n');

      await sendZapiMessage(
        `🕓 Horários disponíveis para *${formatarDataHora(dataISO, 'data')}*:\n` +
        `\`\`\`\n${horariosFormatados}\n\`\`\`\n` +
        `Por favor, digite o horário desejado no formato *HH:mm* (exemplo: 09:30)`
      );

      return res.status(200).send("Horários enviados");
    }

    if (intent === 'CapturarHorarioDisponivel') {
      const ctx = getContext(queryResult, 'aguardando_horario_disponivel');
      if (!ctx) {
        console.error("❌ Contexto 'aguardando_horario_disponivel' não encontrado");
        return res.status(200).send("Erro de contexto");
      }

      const dataCtx = ctx?.parameters?.data || ctx?.parameters?.dataISO;
      const dt = DateTime.fromISO(dataCtx, { zone: 'America/Sao_Paulo' });
      const dataISO = dt.isValid ? dt.toFormat('yyyy-MM-dd') : null;

      if (!ctx || !dataISO) {
        console.error("❌ Contexto ou data inválida:", ctx, dataISO);
        await sendZapiMessage("❌ Houve um erro ao recuperar a data. Por favor, envie novamente.");
        return res.status(200).send("Erro de contexto ou data");
      }

      const nome = ctx?.parameters?.nome || 'Paciente';
      const tipoAgendamento = ctx?.parameters?.tipoAgendamento || 'Agendamento';

      // 🔥 Extração correta da hora SEM ERRO DE FUSO
      const horaOriginal = parameters?.['hora.original'] || extractFallbackFields(message).hora;

      const hora = extrairHoraSeguro(parameters, message);

      console.log("🕓 Hora recebida:", hora, "| Parâmetro original:", horaOriginal);

      if (!hora || hora === 'Hora inválida') {
        await sendZapiMessage("❌ Não entendi o horário. Envie no formato *HH:mm*, como 09:30");
        return res.status(200).send("Erro no horário");
      }

      const dataFormatada = formatarDataHora(dataISO, 'data');
      const horariosDisponiveis = await listarHorariosDisponiveis(dataISO);

      if (!horariosDisponiveis.includes(hora)) {
        await sendZapiMessage(
          `⚠️ Esse horário também está ocupado.\nEscolha um destes disponíveis:\n` +
          horariosDisponiveis.join(' | ')
        );
        return res.status(200).send("Horário não disponível");
      }

      await setContext(res, 'aguardando_procedimento', 3, {
        telefone: cleanPhone,
        nome,
        dataFormatada,
        dataISO,
        hora,
        tipoAgendamento
      }, sessionId);
      console.log("📅 Dados do agendamento:", {
        nome,
        telefone: cleanPhone,
        dataISO,
        hora,
        tipoAgendamento,
        dataFormatada
      });

      await sendZapiMessage(
        `Perfeito! Agora me diga qual é o *procedimento* que deseja realizar (ex: limpeza, clareamento, aparelho...). 🦷`
      );

      return res.status(200).send("Aguardando procedimento");
    }

    if (intent === 'CapturarProcedimento') {
      const ctx = getContext(queryResult, 'aguardando_procedimento');
      if (!ctx) {
        console.error("❌ Contexto 'aguardando_procedimento' não encontrado");
        return res.status(200).send("Erro de contexto");
      }
      const procedimento = parameters?.procedimento || fallback.procedimento;
      console.log("📋 Procedimento recebido:", procedimento);

      const nome = getParametroDosContextos(outputContexts, 'nome');
      const telefone = String(req.body.phone).replace(/\D/g, '');
      const dataISO = getParametroDosContextos(outputContexts, 'dataISO');
      const hora = getParametroDosContextos(outputContexts, 'hora');
      const tipoAgendamento = getParametroDosContextos(outputContexts, 'tipoAgendamento');
      const dataFormatada = formatarDataHora(dataISO, 'data');
      if (!nome || !telefone || !dataISO || !hora || !tipoAgendamento) {
        return res.status(200).send("Dados incompletos");
      }
      console.log("📞 Telefone:", telefone, "| Nome:", nome, "| Data:", dataISO, "| Hora:", hora, "| Tipo:", tipoAgendamento, "Procedimento:", procedimento);

      await confirmarAgendamento({
        nome,
        telefone,
        dataISO,
        hora,
        tipoAgendamento,
        procedimento,
        dataFormatada
      });

      return res.status(200).send("Agendamento finalizado");
    }

    // ⚠️ Nenhuma intent reconhecida (intent === undefined) e contexto de horário disponível ativo
    if (!intent && getContext(queryResult, 'aguardando_horario_disponivel')) {
      const mensagem = message?.text?.message || '';
      const regex = /(\d{1,2})[:h]?(\d{2})?/;
      const match = mensagem.match(regex);

      if (match) {
        const h = match[1].padStart(2, '0');
        const m = match[2] ? match[2].padStart(2, '0') : '00';
        const hora = `${h}:${m}`;

        const ctx = getContext(queryResult, 'aguardando_horario_disponivel');
        const { nome, telefone, dataISO, tipoAgendamento, procedimento } = ctx.parameters;
        const dataFormatada = formatarDataHora(dataISO, 'data');

        const horariosDisponiveis = await listarHorariosDisponiveis(dataISO);
        if (!horariosDisponiveis.includes(hora)) {
          await sendZapiMessage(`⚠️ Esse horário também está ocupado.\nEscolha um desses:\n` + horariosDisponiveis.join('\n'));
          return res.status(200).send("Horário inválido");
        }

        await confirmarAgendamento({ nome, telefone, dataISO, hora, tipoAgendamento, procedimento, dataFormatada });
        return res.status(200).send("Agendamento confirmado (via fallback)");
      }
    }

    if (intent === 'FalarComAtendente') {
      try {
        await notifyTelegram(cleanPhone, message);
        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'transbordo humano',
          intent
        });

        const resposta = 'Já te coloco em contato com alguém da nossa equipe 👨‍⚕️. Um momento...';

        await sendZapiMessage(resposta);

        return res.status(200).send(); // confirma que o webhook respondeu
      } catch (error) {
        console.error('Erro ao encaminhar para atendimento humano:', error);
        return res.status(500).send("Erro ao processar a solicitação");
      }
    }

    if (intent === 'VerificarListaConvenios') {
      const ctxConfirmacao = queryResult.outputContexts?.find(ctx => ctx.name.includes('aguardando-confirmacao-lista-convenios'));

      if (ctxConfirmacao) {
        // Normalize a mensagem do usuário
        const messageNormalized = normalize(message);

        // Tentativa de obter o convênio informado via parâmetros
        let convenioInformado =
          parameters?.convenio_aceito ||
          parameters?.convenio;

        // Fallback se parameters estiverem vazios ou for um objeto vazio
        if (
          !convenioInformado ||
          (typeof convenioInformado === 'object' && Object.keys(convenioInformado).length === 0)
        ) {
          convenioInformado = detectarConvenioNaFrase(messageNormalized, conveniosAceitos);
        }

        // Normaliza o valor final do convênio informado
        const convenioTexto =
          typeof convenioInformado === 'string'
            ? convenioInformado
            : typeof convenioInformado?.value === 'string'
              ? convenioInformado.value
              : '';

        const textoConvenio = normalize(convenioTexto);

        // Detecta se é ou não um convênio aceito
        const convenioDetectado = detectarConvenioNaFrase(textoConvenio, conveniosAceitos);

        // ⛔️ Se não encontrou convênio válido, dispara evento ConvenioNaoAtendido
        if (!convenioDetectado) {
          console.log('❌ Nenhum convênio detectado. Disparando evento ConvenioNaoAtendido');
          await logToSheet({
            phone: cleanPhone,
            message,
            type: 'bot',
            intent: `ConvenioNaoAtendido (evento disparado)`
          });
          const naoAtendidoResponse = await axios.post(
            `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
            {
              queryInput: {
                event: {
                  name: 'ConvenioNaoAtendido',
                  languageCode: 'pt-BR'
                }
              }
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const followupText = naoAtendidoResponse.data.queryResult.fulfillmentText;
          console.log("🤖 Resposta do evento (NaoAtendido):", followupText);
          if (followupText) {
            await sendZapiMessage(followupText);
          }
          return res.status(200).send("Evento ConvenioNaoAtendido disparado");
        }

        // 🟢 Se chegou aqui, convênio foi identificado — segue fluxo normal:
        const followup = convenioDetectado ? 'ConvenioAtendido' : 'ConvenioNaoAtendido';

        // Formata o nome do convênio com letras maiúsculas
        const convenioFormatado = toTitleCase(convenioDetectado || '');

        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: `${followup} (event redirect)`
        });

        // LOGS DE DEPURAÇÃO - CONVÊNIO
        console.log('🔎 Convênio detectado:', convenioDetectado);
        console.log('📤 Enviando evento:', followup, 'com parâmetro:', { convenio: convenioFormatado || '[nenhum parâmetro]' });

        const eventPayload = {
          name: followup,
          languageCode: 'pt-BR',
          ...(convenioDetectado && { parameters: { convenio: convenioFormatado } }) // só adiciona se existir
        };

        // Envia evento para Dialogflow com nome capitalizado
        const followupResponse = await axios.post(
          `https://dialogflow.googleapis.com/v2/projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`,
          {
            queryInput: {
              event: eventPayload
            }
          },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const followupText = followupResponse.data.queryResult.fulfillmentText;
        console.log("🤖 Resposta do evento:", followupText);

        if (followupText) {
          await sendZapiMessage(followupText);
        }

        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: `${followup} (evento disparado)`
        });

        return res.status(200).send("Followup executado");
      }
    }

    // 🚨 Contexto urgência
    const contextoNome = getContext(queryResult, 'aguardando_nome_urgencia');
    const contextoDescricao = getContext(queryResult, 'aguardando_descricao');
    const contextoEncerrado = getContext(queryResult, 'urgencia_encerrada');
    const nomeCompleto = parameters?.nome || contextoDescricao?.parameters?.nome || contextoNome?.parameters?.nome;
    const descricaoCompleta = parameters?.descricao || contextoDescricao?.parameters?.descricao;
    if (contextoEncerrado && (!nomeCompleto || !descricaoCompleta)) {
      console.log("🛑 Urgência já encerrada, ignorando nova mensagem.");
      return res.status(200).send(); // Não responde nada
    }
    // Garante que o fluxo só continue se a intent for 'Urgencia' OU se os contextos estiverem ativos
    if (intent === 'Urgencia' || intent === 'UrgenciaCapturaNome' || intent === 'UrgenciaCapturaDescricao' || contextoNome || contextoDescricao) {
      console.log("📥 Intent: Urgencia");

      const rawMessage = message?.text?.message || '';
      const fallback = extractFallbackFields(message);
      const nomeBruto =
        parameters?.nome?.trim() ||
        contextoDescricao?.parameters?.nome?.trim() ||  // 🔁 Pega do contexto atual
        contextoNome?.parameters?.nome?.trim() ||
        fallback.nome?.trim() || '';
      const descricaoBruta = parameters?.descricao || contextoDescricao?.parameters?.descricao || rawMessage.trim();

      const nome = capitalizarNomeCompleto((nomeBruto || '').trim().split(/\s+/).slice(0, 4).join(' '));
      const descricao = (descricaoBruta || '').trim();

      // Fluxo inicial - solicitar nome
      if (!contextoNome && !contextoDescricao && !nome) {
        console.log("🔍 Contexto de nome não encontrado, solicitando nome do usuário.");
        await sendZapiMessage('Para agilizar o atendimento de urgência, informe *seu nome* por favor:');
        await setContext(res, 'aguardando_nome_urgencia', 2, {}, sessionId);
        return res.status(200).send();
      }

      // Se ainda assim não houver nome, mas já tiver contexto de nome
      if (contextoNome && !contextoDescricao && !descricao) {
        if (!nome) {
          console.log("🔍 Contexto de nome encontrado, mas nome não informado.");
          await sendZapiMessage('Para agilizar o atendimento de urgência, informe *seu nome* por favor:');
          await setContext(res, 'aguardando_nome_urgencia', 2, {}, sessionId);
          return res.status(200).send();
        }
        // Tendo o nome, pergunta pela descrição
        console.log("🔍 Nome encontrado, solicitando descrição do problema.");
        await sendZapiMessage(`Obrigado, ${nome}! Agora me diga *qual é o problema, o que está sentindo*?`);
        await setContext(res, 'aguardando_descricao', 2, { nome }, sessionId);
        return res.status(200).send();
      }

      // Após nome e descrição — finalizar
      console.log("📥 Dados completos para urgência:", { nome, descricao });
      if (nome && descricao) {
        await notifyTelegram(cleanPhone, `🆘 Urgência:\n👤 Nome: ${nome}\n📱 Telefone: ${cleanPhone}\n📄 Descrição: ${descricao}`);

        await logToSheet({
          phone: cleanPhone,
          message: descricao,
          nome,
          type: 'urgência',
          intent
        });

        await sendZapiMessage(`Recebido, ${nome}! Vamos priorizar seu atendimento 🦷💙`);
        await setContext(res, 'aguardando_nome_urgencia', 0, {}, sessionId);
        await setContext(res, 'aguardando_descricao', 0, {}, sessionId);
        await setContext(res, 'urgencia_encerrada', 1, {}, sessionId);

        console.log("✅ Mensagem enviada e contextos atualizados.");
        return res.status(200).send();
      }

      // Se algo deu errado e chegou aqui, repete a pergunta anterior
      console.log("🔍 Dados incompletos, solicitando novamente.");
      const fallbackText = !nome ? 'Pode me informar seu *nome* por favor?'
        : 'Me diga *qual é o problema, o que está sentindo*?';
      await sendZapiMessage(fallbackText);
      return res.status(200).send();
    }

    // Contador de tentativas de entendimento usando contexto de sessão com contagem de falhas
    if (intent && !reply) {
      const contextoTentativa = queryResult?.outputContexts?.find(ctx => ctx.name.includes('tentativa-entendimento'));
      const falhas = contextoTentativa?.parameters?.falhas || 0;

      if (falhas >= 1) {
        // Segunda falha: transbordo para atendente
        await sendZapiMessage('Vou acionar um atendente 👩‍💻 Aguarde só um instante ');
        await notifyTelegram(cleanPhone, message);
        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'transbordo humano',
          intent: 'FallbackDepoisDeFalha'
        });
        return res.status(200).json({
          fulfillmentText: 'Encaminhando para atendente...',
          outputContexts: [] // encerra o contexto
        });
      } else {
        // Primeira falha: responde e seta contexto com falhas = 1
        const respostaPadrao = 'Desculpe, não entendi direito... Pode repetir por favor?';
        await sendZapiMessage(respostaPadrao);
        await logToSheet({
          phone: cleanPhone,
          message,
          type: 'bot',
          intent: 'RespostaVazia'
        });

        return res.status(200).json({
          fulfillmentText: respostaPadrao,
          outputContexts: [{
            name: `projects/${DF_PROJECT_ID}/agent/sessions/${sessionId}/contexts/tentativa-entendimento`,
            lifespanCount: 1,
            parameters: {
              falhas: 1
            }
          }]
        });
      }
    }

    if (reply) {
      await sendZapiMessage(reply);
      await logToSheet({
        phone: cleanPhone,
        message: reply,
        type: 'bot',
        intent
      });
      return res.status(200).send("OK");
    } else {
      console.warn("⚠️ Nenhuma resposta definida para a intent.");
    }

    await logToSheet({ phone: cleanPhone, message, type: 'transbordo humano', intent: 'FallbackManual' });
    return res.status(200).send("Mensagem humana registrada.");

  } catch (err) {
    console.error("❌ Erro ao processar mensagem:", err.message);
    res.status(500).send("Erro ao processar");
  }
});

// Rota para capturar as mensagens enviadas do atendente para o cliente
app.post('/zapi-outgoing', async (req, res) => {
  console.log("📩 Webhook de saída recebido:");
  console.dir(req.body, { depth: null });
  console.log("🔍 Tipo de evento:", req.body.type || 'sem tipo');

  const { type, phone } = req.body;
  let text = '';

  // Tenta extrair o texto da mensagem enviada
  if (typeof req.body.message === 'string') {
    text = req.body.message;
  } else if (req.body.message?.text?.body) {
    text = req.body.message.text.body;
  } else if (req.body.message?.message) {
    text = req.body.message.message;
  } else if (req.body.message?.body) {
    text = req.body.message.body;
  }

  if (type === 'SentCallback' && text && phone) {
    console.log("📝 Conteúdo detectado como mensagem humana:", text);
  }

  // Filtra somente mensagens que são de saída (enviadas pelo humano manualmente)
  if (type === 'SentCallback' && text && phone) {
    const cleanPhone = phone.replace(/\D/g, '');

    // Ignora mensagens automáticas
    if (!text.includes("Seu atendimento foi marcado como resolvido")) {
      await logToSheet({ phone: cleanPhone, message: text, type: 'bot' });
      console.log("✅ Mensagem humana registrada no Sheets:", text);
    }
  }
  res.sendStatus(200);
});


// Rota para o webhook do Telegram que escuta cliques nos botões
app.post('/telegram-webhook', async (req, res) => {
  const callbackQuery = req.body.callback_query;
  const messageText = req.body.message?.text;

  if (messageText === '/status') {
    try {
      const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: 'Atendimentos!A:D'
      });
      const values = response.data.values || [];
      const pendentes = values.filter(row => row[3] === 'transbordo humano');
      const msg = `🤖 Atualmente há *${pendentes.length}* atendimento(s) pendente(s).`;
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      console.error("Erro ao responder /status:", err.message);
    }
  }

  // Comando /clientes para listar clientes em atendimento
  if (messageText === '/clientes') {
    try {
      const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEETS_ID,
        range: 'Atendimentos!A:D'
      });
      const values = response.data.values || [];

      // Filtra os que estão em atendimento humano
      const pendentes = values.filter(row => row[3] === 'humano');

      // Monta a mensagem apenas com nome, telefone e link do WhatsApp
      const msg = pendentes.length
        ? `*Clientes em atendimento:*\n${pendentes.map(p => {
          const nome = p[0];
          const telefone = p[1].replace(/\D/g, '');
          const telefoneFormatado = p[1];
          return `👤 *${nome}*\n📞 ${telefoneFormatado} | [Abrir WhatsApp](https://wa.me/${telefone})`;
        }).join('\n\n')}`
        : `✅ Nenhum cliente aguardando atendimento.`;

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'Markdown',
        disable_web_page_preview: true // Removendo o preview do botão do WhatsApp (share on whatsapp)
      });
    } catch (err) {
      console.error("Erro ao responder /clientes:", err.message);
    }
  }


  if (callbackQuery && callbackQuery.data) {
    const [action, phone] = callbackQuery.data.split(':');

    if (action === 'resolve') {
      const replyText = `✅ Atendimento com o número *${phone}* foi marcado como resolvido.`;
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: replyText,
        parse_mode: "Markdown"
      });

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone,
        message: "Seu atendimento foi marcado como resolvido. Qualquer dúvida, é só chamar 😊"
      }, {
        headers: {
          'Client-Token': ZAPI_CLIENT_TOKEN,
          'Content-Type': 'application/json'
        }
      });
    }

    if (action === 'historico') {
      try {
        const sheets = google.sheets({ version: 'v4', auth: await getSheetsAuthClient() });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: GOOGLE_SHEETS_ID,
          range: 'Atendimentos!A:D'
        });


        const historico = response.data.values?.filter(row => row[1] === phone).slice(-10).reverse();

        const historicoText = historico.length
          ? `📜 *Últimas mensagens de ${phone}:*\n${historico.map(r => `🕓 ${r[0]}\n💬 ${r[2]}\n`).join('\n')}`
          : `Nenhum histórico recente encontrado.`;

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: TELEGRAM_CHAT_ID,
          text: historicoText,
          parse_mode: 'Markdown'
        });
      } catch (err) {
        console.error("Erro ao buscar histórico:", err.message);
      }
    }
  }

  res.sendStatus(200);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor iniciado na porta ${PORT}`);
  });
}

module.exports = {
  formatarDataHora,
  capitalizarNomeCompleto,
  extractFallbackFields
};