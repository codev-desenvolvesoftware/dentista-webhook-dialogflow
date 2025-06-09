const express = require('express');
const bodyParser = require('body-parser');
const { GoogleAuth } = require('google-auth-library');
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
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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

  const startOfDay = new Date(date.setHours(0, 0, 0, 0)).toISOString();
  const endOfDay = new Date(date.setHours(23, 59, 59, 999)).toISOString();

  const events = await calendar.events.list({
    calendarId: 'primary',
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
async function criarEventoGoogleCalendar({ nome, telefone, dataISO, hora, tipo, procedimento, convenio }) {
  const auth = await getCalendarAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const start = new Date(`${dataISO}T${hora}:00-03:00`);
  const end = new Date(start.getTime() + 30 * 60000); // duração de 30 min

  return calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: `${tipo.toUpperCase()} - ${nome}`,
      description: `Procedimento: ${procedimento}\nConvênio: ${convenio}\nTelefone: ${telefone}`,
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
    }
  });
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
  if (typeof valor !== 'string') return '';

  valor = valor.normalize("NFKD").replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!valor) return tipo === 'data' ? 'Data inválida' : '';

  try {

    const { DateTime } = require('luxon');

    if (tipo === 'hora') {
      // Verifica se é uma string ISO (com "T" e possível timezone)
      const isoRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;
      if (isoRegex.test(valor)) {
        try {
          const horaLuxon = DateTime.fromISO(valor, { zone: 'America/Sao_Paulo' });
          if (!horaLuxon.isValid) return 'Hora inválida';
          return horaLuxon.toFormat('HH:mm');
        } catch (err) {
          return 'Erro ao processar hora ISO';
        }
      }

      // Para valores não ISO, apenas remove espaços e converte para minúsculas
      valor = valor.toLowerCase().trim();

      // Array de expressões regulares para formatos válidos
      const horaRegexes = [
        /^(\d{1,2})h(\d{1,2})$/,   // Ex: 10h30
        /^(\d{1,2})h$/,            // Ex: 10h
        /^(\d{1,2}):(\d{1,2})$/,    // Ex: 10:30
        /^(\d{1,2}):(\d{1,2})h$/,   // Ex: 10:30h
        /^(\d{2})(\d{2})$/,         // Ex: 1030
        /^(\d{1,2})$/              // Ex: 10
      ];

      let horas, minutos;
      for (const regex of horaRegexes) {
        const match = valor.match(regex);
        if (match) {
          horas = match[1];
          minutos = match[2] || '00';
          break;
        }
      }

      // Se nenhum dos formatos foi validado, retorna erro
      if (horas === undefined) return 'Hora inválida';

      // Pad com zeros se necessário
      horas = horas.padStart(2, '0');
      minutos = minutos.padStart(2, '0');

      // Validação extra: valores reais para hora e minuto
      const h = parseInt(horas, 10);
      const m = parseInt(minutos, 10);
      if (h > 23 || m > 59) return 'Hora inválida';

      return `${horas}:${minutos}`;
    }

    if (tipo === 'data') {
      valor = valor.trim();

      const formatos = [
        { regex: /^\d{4}-\d{2}-\d{2}$/, ordem: ['ano', 'mes', 'dia'] },
        { regex: /^\d{2}\/\d{2}\/\d{4}$/, ordem: ['dia', 'mes', 'ano'] },
        { regex: /^\d{2}-\d{2}-\d{4}$/, ordem: ['mes', 'dia', 'ano'] },
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

          if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return 'Data inválida';

          const dateObj = new Date(Date.UTC(ano, mes - 1, dia));
          if (isNaN(dateObj.getTime())) return 'Data inválida';

          return `${dia.toString().padStart(2, '0')}/${mes.toString().padStart(2, '0')}/${ano}`;
        }
      }

      // Só aceita ISO 8601 completo com dia, ex: "2025-05-30T12:00:00-03:00"
      if (!/^\d{4}-\d{2}-\d{2}([T\s].*)?$/.test(valor.trim())) return 'Data inválida';

      const dateObj = new Date(valor);
      if (isNaN(dateObj.getTime())) return 'Data inválida';

      const dia = dateObj.getUTCDate().toString().padStart(2, '0');
      const mes = (dateObj.getUTCMonth() + 1).toString().padStart(2, '0');
      const ano = dateObj.getUTCFullYear();

      return `${dia}/${mes}/${ano}`;
    }

    return '';
  } catch (e) {
    console.error("❌ Erro ao formatar data/hora:", e);
    return '';
  }
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

    console.log("🔍 Contextos ativos:", queryResult.outputContexts);
    console.log("🧠 Intent recebida:", intent);
    console.log("📦 Parâmetros recebidos:", parameters);

    const sendZapiMessage = async (text) => {
      return axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_INSTANCE_TOKEN}/send-text`, {
        phone: cleanPhone,
        message: text
      }, {
        headers: { 'Client-Token': ZAPI_CLIENT_TOKEN }
      });
    };

    // 📆 Função genérica para lidar com agendamento
    const handleAgendamento = async (tipoAgendamento) => {
      try {
        const fallback = extractFallbackFields(message);
        const rawMessage = message?.text?.message || '';

        // Nome
        const nomeRaw = parameters?.nome?.name
          || (Array.isArray(parameters?.nome) ? parameters.nome.join(' ') : parameters?.nome)
          || fallback.nome
          || 'Cliente';

        const nomeFormatado = capitalizarNomeCompleto(
          nomeRaw.trim().split(/\s+/).slice(0, 4).join(' ')
        );

        // Procedimento
        const procedimentoRaw = Array.isArray(parameters?.procedimento)
          ? parameters.procedimento.join(' ')
          : parameters?.procedimento;

        const procedimento = procedimentoRaw || fallback.procedimento || 'procedimento a ser analisado';

        // Data
        const dataISO = (() => {
          const dateParam = parameters?.data || fallback.data;
          if (!dateParam) return null;
          const d = new Date(dateParam);
          return d.toISOString().split('T')[0]; // apenas a data
        })();

        const dataFormatada = formatarDataHora(dataISO, 'data');

        // Hora
        const { DateTime } = require('luxon');
        let hora = (() => {
          const horaTextoRegex = /(\d{1,2})([:h]?)(\d{2})?/gi;
          const matches = [...rawMessage.matchAll(horaTextoRegex)];
          if (matches.length > 0) {
            const ultima = matches[matches.length - 1];
            const h = ultima[1].padStart(2, '0');
            const m = ultima[3] ? ultima[3].padStart(2, '0') : '00';
            return `${h}:${m}`;
          }

          const fallbackHora = formatarDataHora(fallback.hora, 'hora');
          if (fallbackHora && fallbackHora !== 'Hora inválida') return fallbackHora;

          if (parameters?.hora && parameters?.data) {
            try {
              const horaLuxon = DateTime.fromISO(parameters.hora, { zone: 'utc' }).setZone('America/Sao_Paulo');
              const dataLuxon = DateTime.fromISO(parameters.data, { zone: 'America/Sao_Paulo' });
              if (horaLuxon.isValid && dataLuxon.isValid) {
                return horaLuxon.toFormat('HH:mm');
              }
            } catch (e) {
              console.error("Erro ao combinar data e hora:", e);
            }
          }

          return 'a definir';
        })();

        // Convênio
        const contextoConvenio = queryResult.outputContexts?.find(ctx =>
          ctx.parameters?.convenio || ctx.parameters?.convenio_detectado
        );
        const convenio = contextoConvenio?.parameters?.convenio ||
          contextoConvenio?.parameters?.convenio_detectado || '-';

        // 🔍 Verifica se horário está disponível
        const horariosDisponiveis = await listarHorariosDisponiveis(dataISO);
        if (!horariosDisponiveis.includes(hora)) {
          await sendZapiMessage(`⚠️ O horário ${hora} não está mais disponível. Tente um destes:\n${horariosDisponiveis.join('\n')}`);
          return;
        }

        // 🗓️ Criar evento no Google Calendar
        await criarEventoGoogleCalendar({
          nome: nomeFormatado,
          telefone: cleanPhone,
          dataISO,
          hora,
          tipo: tipoAgendamento,
          procedimento,
          convenio
        });

        // 📝 Registrar no Google Sheets
        await logToAgendamentosSheet({
          nome: nomeFormatado,
          telefone: cleanPhone,
          tipoAgendamento,
          data: dataFormatada,
          hora,
          procedimento,
          convenio
        });

        const respostaFinal = `Perfeito, ${nomeFormatado}! Sua ${tipoAgendamento} para ${procedimento} está agendada para ${dataFormatada} às ${hora}. Até lá 🩵`;
        await sendZapiMessage(respostaFinal);

      } catch (err) {
        console.error("❌ Erro no agendamento:", err.message);
        await sendZapiMessage("Tivemos um problema ao concluir o agendamento. Por favor, tente novamente.");
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

    if (intent === 'AgendarAvaliacaoFinal') {
      await handleAgendamento('avaliação');
      return res.status(200).send("OK");
    }

    if (intent === 'AgendarConsultaFinal') {
      await handleAgendamento('consulta');
      return res.status(200).send("OK");
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


    const contextoNome = getContext(queryResult, 'aguardando_nome');
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
        await setContext(res, 'aguardando_nome', 2, {}, sessionId);
        return res.status(200).send();
      }

      // Se ainda assim não houver nome, mas já tiver contexto de nome
      if (contextoNome && !contextoDescricao && !descricao) {
        if (!nome) {
          console.log("🔍 Contexto de nome encontrado, mas nome não informado.");
          await sendZapiMessage('Para agilizar o atendimento de urgência, informe *seu nome* por favor:');
          await setContext(res, 'aguardando_nome', 2, {}, sessionId);
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
        await setContext(res, 'aguardando_nome', 0, {}, sessionId);
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