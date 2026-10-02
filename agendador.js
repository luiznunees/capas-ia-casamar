/*
 * Processo principal no Docker (Easypanel): sobe o painel e agenda as rodadas, no lugar do cron.
 *   IA (melhorar.js --site)        a cada INTERVALO_IA_MIN minutos (padrão 60)
 *   publicar (publicar.js --todos) a cada INTERVALO_PUBLICAR_MIN minutos (padrão 15)
 * Os scripts têm trava própria: se a rodada anterior ainda estiver aberta, a nova sai na hora.
 * Antes de cada rodada da IA, importa a sessão do ChatGPT se uma nova foi enviada pelo painel.
 *
 * Variáveis (Easypanel > Environment):
 *   IA_AUTOMATICA=nao          desliga as rodadas da IA (fica só o painel)
 *   PUBLICAR_AUTOMATICO=nao    desliga a publicação automática (publica só pelo painel)
 *   INTERVALO_IA_MIN, INTERVALO_PUBLICAR_MIN
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
fs.mkdirSync(LOGS, { recursive: true });

const hoje = () => new Date().toLocaleDateString('sv-SE');   // AAAA-MM-DD no fuso do container
const agora = () => new Date().toLocaleString('pt-BR');

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

let iaAberta = false;
async function cicloIA() {
  if (iaAberta) return;
  iaAberta = true;
  try {
    if (sessao.pendente()) {
      console.log(`[${agora()}] importando a sessão do ChatGPT enviada pelo painel...`);
      if (await rodar('ia', ['melhorar.js', `--importar-sessao=${sessao.arquivo}`]) === 0) sessao.marcarImportada();
    }
    await rodar('ia', ['melhorar.js', '--site']);
  } finally {
    iaAberta = false;
  }
}

let pubAberta = false;
async function cicloPublicar() {
  if (pubAberta) return;
  pubAberta = true;
  try { await rodar('publicar', ['publicar.js', '--todos']); } finally { pubAberta = false; }
}

function limparLogsVelhos() {
  const limite = Date.now() - 14 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(LOGS)) {
    const arq = path.join(LOGS, f);
    try { if (fs.statSync(arq).mtimeMs < limite) fs.unlinkSync(arq); } catch {}
  }
}

// o painel (mesmo processo) dispara as rodadas na hora: POST /api/rodada/ia ou /api/rodada/publicar
global.agendador = {
  ia: cicloIA,
  publicar: cicloPublicar,
  situacao: () => ({ iaAberta, pubAberta, iaLigada: IA_LIGADA, pubLigada: PUB_LIGADA, minIA: MIN_IA, minPub: MIN_PUB }),
};
require('./painel');

console.log(`[${agora()}] agendador: IA ${IA_LIGADA ? `a cada ${MIN_IA} min` : 'DESLIGADA'}, publicação ${PUB_LIGADA ? `a cada ${MIN_PUB} min` : 'DESLIGADA'}`);
if (IA_LIGADA) {
  setTimeout(cicloIA, 20 * 1000);
  setInterval(cicloIA, MIN_IA * 60 * 1000);
}
if (PUB_LIGADA) {
  setTimeout(cicloPublicar, 90 * 1000);
  setInterval(cicloPublicar, MIN_PUB * 60 * 1000);
}
limparLogsVelhos();
setInterval(limparLogsVelhos, 24 * 3600 * 1000);
