// Alertas no WhatsApp pela Evolution API (config.alertas: url, instancia, apikey, numero).
// Cada tipo de alerta tem intervalo mínimo entre envios, para não lotar o WhatsApp com o mesmo aviso.

const fs = require('fs');
const path = require('path');
const { DADOS, lerConfig } = require('./fotos');

const ARQ_ENVIOS = path.join(DADOS, 'alertas-envios.json');
const INTERVALO_HORAS = { 'sessao-chatgpt': 6, 'login-jetimob': 6, 'site-desativou': 1, 'ia-falhou': 6, resumo: 0, teste: 0 };

const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };

function configurado(a = lerConfig().alertas) {
  return !!(a.url && a.instancia && a.apikey && a.numero);
}

// Evolution v2 aceita { number, text }; a v1 espera { number, textMessage: { text } }.
async function enviarTexto(texto, a = lerConfig().alertas) {
  if (!configurado(a)) throw new Error('alertas não configurados (URL, instância, apikey e número)');
  const url = `${a.url.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(a.instancia)}`;
  // grupo vai como está (1203...@g.us); número fica só com os dígitos
  const numero = String(a.numero).includes('@') ? String(a.numero).trim() : String(a.numero).replace(/\D/g, '');
  const tentar = (corpo) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: a.apikey },
    body: JSON.stringify(corpo),
  });
  let r = await tentar({ number: numero, text: texto });
  if (r.status === 400) r = await tentar({ number: numero, textMessage: { text: texto } });
  if (!r.ok) throw new Error(`Evolution respondeu HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

// tipo: chave do INTERVALO_HORAS. Respeita os interruptores resumo/falhas do painel.
async function alertar(tipo, texto) {
  const a = lerConfig().alertas;
  if (!configurado(a)) return false;
  if (tipo === 'resumo' && !a.resumo) return false;
  if (tipo !== 'resumo' && tipo !== 'teste' && !a.falhas) return false;
  const envios = lerJson(ARQ_ENVIOS, {});
  const espera = (INTERVALO_HORAS[tipo] ?? 6) * 3600 * 1000;
  if (envios[tipo] && Date.now() - envios[tipo] < espera) return false;
  try {
    await enviarTexto(`🏠 *Capas IA* · _Casa Mar_\n\n${texto}`, a);
    envios[tipo] = Date.now();
    fs.writeFileSync(ARQ_ENVIOS, JSON.stringify(envios));
    return true;
  } catch (e) {
    console.log(`(aviso: alerta "${tipo}" não enviado: ${e.message})`);
    return false;
  }
}

// Grupos da instância, para escolher no painel: [{ id: '1203...@g.us', nome }]
async function listarGrupos(a = lerConfig().alertas) {
  if (!a.url || !a.instancia || !a.apikey) throw new Error('preencha URL, instância e API key antes');
  const r = await fetch(`${a.url.replace(/\/+$/, '')}/group/fetchAllGroups/${encodeURIComponent(a.instancia)}?getParticipants=false`, {
    headers: { apikey: a.apikey },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) {
    const msg = j?.response?.message ? [].concat(j.response.message).join(' ') : `HTTP ${r.status}`;
    throw new Error(`Evolution: ${msg}`);
  }
  return j.map(g => ({ id: g.id, nome: g.subject || g.id })).sort((x, y) => x.nome.localeCompare(y.nome));
}

module.exports = { alertar, enviarTexto, configurado, listarGrupos };
