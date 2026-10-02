/*
 * Processo principal no Docker (Easypanel): sobe o painel e agenda as rodadas, no lugar do cron.
 * Tudo é configurável pelo painel (aba Controles, salvo em $DADOS_DIR/config.json) e relido a cada ciclo:
 *   janela de horário (padrão 00h–06h), IA/publicação automáticas ligadas ou não, abas, prioridades.
 *   IA (melhorar.js --site)        começa na janela; no fim dela para de pegar imóvel novo
 *   publicar (publicar.js --todos) a cada INTERVALO_PUBLICAR_MIN minutos dentro da janela
 * Os botões do painel (gerar/publicar um imóvel, "Rodar agora") funcionam a qualquer hora.
 * Alertas no WhatsApp (alertas.js): login do ChatGPT/Jetimob caiu, site desativou imóvel, resumo da madrugada.
 * Logs em $DADOS_DIR/logs/<ia|publicar>-AAAA-MM-DD.log (14 dias); histórico em $DADOS_DIR/rodadas.json.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DADOS, sessao, lerConfig } = require('./fotos');
const { alertar } = require('./alertas');
const { resumo } = require('./resumo');

const LOGS = path.join(DADOS, 'logs');
const ARQ_RODADAS = path.join(DADOS, 'rodadas.json');
const MIN_IA = +(process.env.INTERVALO_IA_MIN || 60);
const MIN_PUB = +(process.env.INTERVALO_PUBLICAR_MIN || 15);
fs.mkdirSync(LOGS, { recursive: true });

const hoje = () => new Date().toLocaleDateString('sv-SE');   // AAAA-MM-DD no fuso do container (TZ)
const agora = () => new Date().toLocaleString('pt-BR');
const hh = (h) => `${String(h).padStart(2, '0')}h`;
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };

// ---------- janela de horário ----------
// Dentro da janela: devolve quando ela termina. Fora: null. Janela de 24h: "sem prazo".
const SEM_PRAZO = 'sem prazo';
function fimDaJanela(cfg = lerConfig()) {
  const ini = cfg.janelaInicio, fim = cfg.janelaFim;
  if (ini === fim) return SEM_PRAZO;
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  const dentro = ini < fim ? (h >= ini && h < fim) : (h >= ini || h < fim);
  if (!dentro) return null;
  const f = new Date(d);
  f.setHours(fim, 0, 0, 0);
  if (f <= d) f.setDate(f.getDate() + 1);
  return f;
}
const prazoArgs = (fim) => (fim && fim !== SEM_PRAZO ? [`--ate=${fim.toISOString()}`] : []);
const textoJanela = (cfg = lerConfig()) => (cfg.janelaInicio === cfg.janelaFim ? 'o dia todo' : `${hh(cfg.janelaInicio)}–${hh(cfg.janelaFim)}`);

// ---------- sinais na saída dos scripts que viram alerta ----------
const SINAIS = [
  [/Não está logado no ChatGPT|Sessão do ChatGPT caiu/, 'sessao-chatgpt',
    'O login do ChatGPT caiu: a IA parou. No Windows rode "node melhorar.js --exportar-sessao" e envie o arquivo no painel (Controles > Login do ChatGPT).'],
  [/Login no Jetimob falhou|Sessão do Jetimob expirou/, 'login-jetimob',
    'Não consegui entrar no Jetimob: a publicação parou. Confira JET_EMAIL/JET_SENHA no Easypanel (a senha pode ter mudado).'],
  [/Não consegui abrir o Chrome/, 'ia-falhou', 'O Chrome não abriu no servidor; a IA não rodou. Veja os logs no painel.'],
];

// ---------- rodar um script ----------
function registrarRodada(r) {
  const lista = lerJson(ARQ_RODADAS, []);
  lista.push(r);
  fs.writeFileSync(ARQ_RODADAS, JSON.stringify(lista.slice(-40)));
}

// Joga a saída no log do dia, guarda as últimas linhas e os sinais de alerta.
function rodar(nome, args) {
  return new Promise((ok) => {
    const inicio = new Date().toISOString();
    const log = fs.createWriteStream(path.join(LOGS, `${nome}-${hoje()}.log`), { flags: 'a' });
    log.write(`\n===== ${agora()} node ${args.join(' ')}\n`);
    const p = spawn(process.execPath, args, { cwd: __dirname, env: process.env });
    const ultimas = [];
    const sinais = new Map();      // tipo -> mensagem
    const foraDoSite = new Set();
    const guardar = (d) => {
      for (const l of String(d).split(/\r?\n/)) {
        if (!l.trim()) continue;
        ultimas.push(l);
        for (const [re, tipo, msg] of SINAIS) if (re.test(l)) sinais.set(tipo, msg);
        const m = l.match(/IMÓVEL PODE ESTAR FORA DO SITE: rode node publicar\.js --so-site (\d+)/);
        if (m) foraDoSite.add(m[1]);
      }
      if (ultimas.length > 8) ultimas.splice(0, ultimas.length - 8);
    };
    p.stdout.on('data', guardar);
    p.stderr.on('data', guardar);
    p.stdout.pipe(log, { end: false });
    p.stderr.pipe(log, { end: false });
    p.on('error', (e) => { log.end(`erro ao iniciar: ${e.message}\n`); ok(1); });
    p.on('close', async (cod) => {
      log.end(`===== fim (código ${cod})\n`);
      console.log(`[${agora()}] ${nome}: ${args.slice(1).join(' ')} -> ${cod === 0 ? 'ok' : 'código ' + cod}`);
      if (cod !== 0) for (const l of ultimas) console.log(`    ${l}`);
      registrarRodada({ tipo: nome, args: args.slice(1).join(' '), inicio, fim: new Date().toISOString(), codigo: cod, ultimas });
      for (const [tipo, msg] of sinais) await alertar(tipo, msg);
      if (foraDoSite.size) {
        await alertar('site-desativou', `O site desativou ${foraDoSite.size} imóvel(is) e não reativou: ${[...foraDoSite].join(', ')}.\nNo painel, abra o imóvel e clique em Publicar de novo, ou me avise.`);
      }
      ok(cod);
    });
  });
}

// ---------- ciclos ----------
// manual = disparado pelo painel: ignora janela e interruptores, e não tem prazo
let iaAberta = false, ultimoInicioIA = 0;
async function cicloIA(manual = false) {
  if (iaAberta) return;
  const cfg = lerConfig();
  if (!manual && !cfg.iaAutomatica) return;
  const fim = manual ? SEM_PRAZO : fimDaJanela(cfg);
  if (!fim) return;
  if (!manual && Date.now() - ultimoInicioIA < MIN_IA * 60 * 1000) return;
  iaAberta = true;
  ultimoInicioIA = Date.now();
  try {
    if (sessao.pendente()) {
      console.log(`[${agora()}] importando a sessão do ChatGPT enviada pelo painel...`);
      if (await rodar('ia', ['melhorar.js', `--importar-sessao=${sessao.arquivo}`]) === 0) sessao.marcarImportada();
    }
    await rodar('ia', ['melhorar.js', '--site', `--paralelo=${cfg.paralelo}`, ...prazoArgs(fim)]);
  } finally {
    iaAberta = false;
  }
}

let pubAberta = false;
async function cicloPublicar(manual = false) {
  if (pubAberta) return;
  const cfg = lerConfig();
  if (!manual && !cfg.publicarAutomatico) return;
  const fim = manual ? SEM_PRAZO : fimDaJanela(cfg);
  if (!fim) return;
  pubAberta = true;
  try { await rodar('publicar', ['publicar.js', '--todos', ...prazoArgs(fim)]); } finally { pubAberta = false; }
}

// Resumo no WhatsApp quando a janela fecha (só se a IA ou a publicação automática estiverem ligadas).
let inicioJanela = fimDaJanela() && fimDaJanela() !== SEM_PRAZO ? new Date().toISOString() : null;
async function vigiarJanela() {
  const cfg = lerConfig();
  const dentro = fimDaJanela(cfg);
  if (dentro && dentro !== SEM_PRAZO && !inicioJanela) inicioJanela = new Date().toISOString();
  if (!dentro && inicioJanela) {
    const desde = inicioJanela;
    inicioJanela = null;
    if (!cfg.iaAutomatica && !cfg.publicarAutomatico) return;
    const r = resumo({ desde });
    const linhas = [
      `Resumo da madrugada (${textoJanela(cfg)}):`,
      `• ${r.desde.geradas} foto(s) gerada(s) pela IA`,
      `• ${r.desde.publicadas} publicada(s) no site`,
      r.desde.erros ? `• ${r.desde.erros} erro(s) — veja no painel` : '• nenhum erro',
      '',
      r.total ? `No total: ${r.geradas} de ${r.total} imóveis com capa nova, ${r.publicadas} publicadas.` : `No total: ${r.geradas} geradas, ${r.publicadas} publicadas.`,
      r.previsaoDias ? `No ritmo atual, faltam ~${r.previsaoDias} madrugada(s).` : '',
      r.sitePendente ? `⚠️ ${r.sitePendente} publicada(s) esperando o site atualizar.` : '',
    ].filter(l => l !== '');
    await alertar('resumo', linhas.join('\n'));
  }
}

function limparLogsVelhos() {
  const limite = Date.now() - 14 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(LOGS)) {
    const arq = path.join(LOGS, f);
    try { if (fs.statSync(arq).mtimeMs < limite) fs.unlinkSync(arq); } catch {}
  }
}

// ---------- painel (mesmo processo) ----------
global.agendador = {
  ia: () => cicloIA(true),
  publicar: () => cicloPublicar(true),
  situacao: () => {
    const cfg = lerConfig();
    return {
      iaAberta, pubAberta, iaLigada: cfg.iaAutomatica, pubLigada: cfg.publicarAutomatico,
      janela: textoJanela(cfg), dentroDaJanela: !!fimDaJanela(cfg), minIA: MIN_IA, minPub: MIN_PUB,
      rodadas: lerJson(ARQ_RODADAS, []).slice(-12).reverse(),
    };
  },
};
require('./painel');

console.log(`[${agora()}] agendador: janela ${textoJanela()} · config em ${path.join(DADOS, 'config.json')}`);
// a cada 5 min cada ciclo decide se é hora (janela, interruptores e intervalo vêm da config)
setTimeout(() => cicloIA(), 20 * 1000);
setInterval(() => cicloIA(), 5 * 60 * 1000);
setTimeout(() => cicloPublicar(), 90 * 1000);
setInterval(() => cicloPublicar(), MIN_PUB * 60 * 1000);
setInterval(vigiarJanela, 60 * 1000);
limparLogsVelhos();
setInterval(limparLogsVelhos, 24 * 3600 * 1000);
