/*
 * Processo principal no Docker (Easypanel): sobe o painel e agenda as rodadas, no lugar do cron.
 * As rodadas automáticas só acontecem dentro da JANELA (padrão 00h–06h, horário de Brasília):
 *   IA (melhorar.js --site)        começa na janela; às JANELA_FIM para de pegar imóvel novo
 *   publicar (publicar.js --todos) a cada INTERVALO_PUBLICAR_MIN minutos dentro da janela
 * Os botões do painel (gerar/publicar um imóvel, "Rodar agora") funcionam a qualquer hora.
 * Os scripts têm trava própria: se a rodada anterior ainda estiver aberta, a nova sai na hora.
 * Antes de cada rodada da IA, importa a sessão do ChatGPT se uma nova foi enviada pelo painel.
 *
 * Variáveis (Easypanel > Environment):
 *   JANELA_INICIO=0, JANELA_FIM=6  horas da janela (JANELA_INICIO=JANELA_FIM = o dia todo)
 *   IA_AUTOMATICA=nao              desliga as rodadas da IA (fica só o painel)
 *   PUBLICAR_AUTOMATICO=nao        desliga a publicação automática (publica só pelo painel)
 *   INTERVALO_IA_MIN=60            dentro da janela, intervalo mínimo entre o início de duas rodadas da IA
 *   INTERVALO_PUBLICAR_MIN=15
 * Logs em $DADOS_DIR/logs/<ia|publicar>-AAAA-MM-DD.log (mantém 14 dias).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DADOS, sessao } = require('./fotos');

const LOGS = path.join(DADOS, 'logs');
const MIN_IA = +(process.env.INTERVALO_IA_MIN || 60);
const MIN_PUB = +(process.env.INTERVALO_PUBLICAR_MIN || 15);
const IA_LIGADA = process.env.IA_AUTOMATICA !== 'nao';
const PUB_LIGADA = process.env.PUBLICAR_AUTOMATICO !== 'nao';
const INICIO = +(process.env.JANELA_INICIO ?? 0);
const FIM = +(process.env.JANELA_FIM ?? 6);
fs.mkdirSync(LOGS, { recursive: true });

const hoje = () => new Date().toLocaleDateString('sv-SE');   // AAAA-MM-DD no fuso do container (TZ)
const agora = () => new Date().toLocaleString('pt-BR');
const hh = (h) => `${String(h).padStart(2, '0')}h`;

// Dentro da janela: devolve quando ela termina. Fora: null. Janela de 24h: devolve "sem prazo".
const SEM_PRAZO = 'sem prazo';
function fimDaJanela() {
  if (INICIO === FIM) return SEM_PRAZO;
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  const dentro = INICIO < FIM ? (h >= INICIO && h < FIM) : (h >= INICIO || h < FIM);
  if (!dentro) return null;
  const fim = new Date(d);
  fim.setHours(FIM, 0, 0, 0);
  if (fim <= d) fim.setDate(fim.getDate() + 1);
  return fim;
}
const prazoArgs = (fim) => (fim && fim !== SEM_PRAZO ? [`--ate=${fim.toISOString()}`] : []);

// Roda um script e joga a saída no log do dia (e no log do container, resumido).
function rodar(nome, args) {
  return new Promise((ok) => {
    const log = fs.createWriteStream(path.join(LOGS, `${nome}-${hoje()}.log`), { flags: 'a' });
    log.write(`\n===== ${agora()} node ${args.join(' ')}\n`);
    const p = spawn(process.execPath, args, { cwd: __dirname, env: process.env });
    // últimas linhas ficam guardadas para mostrar o motivo no log do Easypanel quando falha
    const ultimas = [];
    const guardar = (d) => {
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) ultimas.push(l);
      if (ultimas.length > 6) ultimas.splice(0, ultimas.length - 6);
    };
    p.stdout.on('data', guardar);
    p.stderr.on('data', guardar);
    p.stdout.pipe(log, { end: false });
    p.stderr.pipe(log, { end: false });
    p.on('error', (e) => { log.end(`erro ao iniciar: ${e.message}\n`); ok(1); });
    p.on('close', (cod) => {
      log.end(`===== fim (código ${cod})\n`);
      console.log(`[${agora()}] ${nome}: ${args.slice(1).join(' ')} -> ${cod === 0 ? 'ok' : 'código ' + cod}`);
      if (cod !== 0) for (const l of ultimas) console.log(`    ${l}`);
      ok(cod);
    });
  });
}

// manual = disparado pelo painel: ignora a janela e não tem prazo
let iaAberta = false, ultimoInicioIA = 0;
async function cicloIA(manual = false) {
  if (iaAberta) return;
  const fim = manual ? SEM_PRAZO : fimDaJanela();
  if (!fim) return;
  if (!manual && Date.now() - ultimoInicioIA < MIN_IA * 60 * 1000) return;
  iaAberta = true;
  ultimoInicioIA = Date.now();
  try {
    if (sessao.pendente()) {
      console.log(`[${agora()}] importando a sessão do ChatGPT enviada pelo painel...`);
      if (await rodar('ia', ['melhorar.js', `--importar-sessao=${sessao.arquivo}`]) === 0) sessao.marcarImportada();
    }
    await rodar('ia', ['melhorar.js', '--site', ...prazoArgs(fim)]);
  } finally {
    iaAberta = false;
  }
}

let pubAberta = false;
async function cicloPublicar(manual = false) {
  if (pubAberta) return;
  const fim = manual ? SEM_PRAZO : fimDaJanela();
  if (!fim) return;
  pubAberta = true;
  try { await rodar('publicar', ['publicar.js', '--todos', ...prazoArgs(fim)]); } finally { pubAberta = false; }
}

function limparLogsVelhos() {
  const limite = Date.now() - 14 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(LOGS)) {
    const arq = path.join(LOGS, f);
    try { if (fs.statSync(arq).mtimeMs < limite) fs.unlinkSync(arq); } catch {}
  }
}

// o painel (mesmo processo) dispara as rodadas na hora: POST /api/rodada/ia ou /api/rodada/publicar
const janelaTexto = INICIO === FIM ? 'o dia todo' : `${hh(INICIO)}–${hh(FIM)}`;
global.agendador = {
  ia: () => cicloIA(true),
  publicar: () => cicloPublicar(true),
  situacao: () => ({
    iaAberta, pubAberta, iaLigada: IA_LIGADA, pubLigada: PUB_LIGADA,
    janela: janelaTexto, dentroDaJanela: !!fimDaJanela(), minIA: MIN_IA, minPub: MIN_PUB,
  }),
};
require('./painel');

console.log(`[${agora()}] agendador: janela ${janelaTexto} · IA ${IA_LIGADA ? 'ligada' : 'DESLIGADA'} · publicação ${PUB_LIGADA ? `a cada ${MIN_PUB} min` : 'DESLIGADA'}`);
// confere a janela a cada 5 min; cada ciclo decide se é hora de rodar
if (IA_LIGADA) {
  setTimeout(() => cicloIA(), 20 * 1000);
  setInterval(() => cicloIA(), 5 * 60 * 1000);
}
if (PUB_LIGADA) {
  setTimeout(() => cicloPublicar(), 90 * 1000);
  setInterval(() => cicloPublicar(), MIN_PUB * 60 * 1000);
}
limparLogsVelhos();
setInterval(limparLogsVelhos, 24 * 3600 * 1000);
