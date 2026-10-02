/*
 * Painel para atualizar a foto de capa de UM imóvel: mostra se já tem foto gerada pela IA,
 * se já foi publicada, e tem botões para gerar (ou gerar de novo) e publicar.
 *
 * USO:
 *   node painel.js                -> http://localhost:3020
 *   PAINEL_PORTA=8080 node painel.js
 *
 * Na VPS: por padrão só escuta em 127.0.0.1. Acesse por túnel SSH
 *   ssh -L 3020:localhost:3020 usuario@IP     e abra http://localhost:3020
 * ou exponha com PAINEL_HOST=0.0.0.0 e PAINEL_SENHA=... (pede usuário qualquer + essa senha).
 *
 * Por baixo chama os mesmos scripts do cron:
 *   gerar    -> node melhorar.js <url-do-imóvel> --forcar
 *               (se a rodada automática estiver aberta, o pedido entra na frente da fila dela: saida/urgente.txt)
 *   publicar -> node publicar.js <código>  (se o cron estiver publicando, espera ele terminar e tenta de novo)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DADOS, SAIDA, sessao, resolver, urlDoImovel } = require('./fotos');

const PORTA = +(process.env.PAINEL_PORTA || 3020);
const HOST = process.env.PAINEL_HOST || '127.0.0.1';
const SENHA = process.env.PAINEL_SENHA || '';
const PASTA_ORIG = path.join(SAIDA, '_originais');
const ARQ_ESTADO = path.join(SAIDA, 'estado.json');
const ARQ_PUBLICADOS = path.join(SAIDA, 'publicados.json');
const ARQ_URGENTE = path.join(SAIDA, 'urgente.txt');
const ARQ_REJEITADOS = path.join(DADOS, 'rejeitados.txt');

const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };
const lerLista = (arq) => fs.existsSync(arq)
  ? fs.readFileSync(arq, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : [];

function travaViva(arq) {
  const pid = +lerJson(arq, {}).pid || 0;
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------- página do imóvel no site (com cache curto) ----------
const cacheSite = new Map();   // código -> { em, url, capa }
async function dadosDoSite(codigo) {
  const c = cacheSite.get(codigo);
  if (c && Date.now() - c.em < 5 * 60 * 1000) return c;
  const url = await urlDoImovel(codigo);
  let capa = null;
  if (url) capa = (await resolver(url, 0).catch(() => null))?.origem || null;
  const d = { em: Date.now(), url, capa };
  cacheSite.set(codigo, d);
  return d;
}

// ---------- tarefas (gerar / publicar) ----------
const tarefas = new Map();     // código -> tarefa mais recente

function novaTarefa(codigo, tipo) {
  const t = { tipo, inicio: new Date().toISOString(), fim: null, ok: null, log: [] };
  tarefas.set(codigo, t);
  return t;
}
const anotar = (t, texto) => {
  for (const l of String(texto).split(/\r?\n/)) if (l.trim()) t.log.push(l);
  if (t.log.length > 400) t.log.splice(0, t.log.length - 400);
};

function rodarScript(t, script, args, aoFim) {
  // Chrome com janela precisa de tela: na VPS sem DISPLAY, usa a tela virtual
  const semTela = process.platform === 'linux' && !process.env.DISPLAY && script === 'melhorar.js';
  const cmd = semTela ? 'xvfb-run' : process.execPath;
  const argv = semTela ? ['-a', process.execPath, script, ...args] : [script, ...args];
  const p = spawn(cmd, argv, { cwd: __dirname, env: process.env });
  p.stdout.on('data', d => anotar(t, d));
  p.stderr.on('data', d => anotar(t, d));
  p.on('error', e => { anotar(t, `erro ao iniciar: ${e.message}`); aoFim(1); });
  p.on('close', codigoSaida => aoFim(codigoSaida));
}

function gerar(codigo, urlSite) {
  const t = novaTarefa(codigo, 'gerar');
  if (travaViva(path.join(SAIDA, '.rodando'))) {
    // a rodada automática está com o Chrome do ChatGPT aberto: entra na frente da fila dela
    fs.appendFileSync(ARQ_URGENTE, urlSite + '\n');
    t.naFila = true;
    anotar(t, 'A rodada automática da IA está aberta. Seu pedido entrou na frente da fila dela;');
    anotar(t, 'começa na próxima aba livre (geralmente 1 a 2 minutos) e leva ~1 minuto.');
    return t;
  }
  anotar(t, 'Abrindo o ChatGPT...');
  rodarScript(t, 'melhorar.js', [urlSite, '--forcar'], (cod) => {
    t.fim = new Date().toISOString();
    t.ok = cod === 0;
  });
  return t;
}

function publicar(codigo, tentativa = 1, t = novaTarefa(codigo, 'publicar')) {
  rodarScript(t, 'publicar.js', [codigo], (cod) => {
    const ocupado = t.log.some(l => l.includes('Já tem uma publicação em andamento'));
    if (ocupado && tentativa < 40) {
      t.log = t.log.filter(l => !l.includes('Já tem uma publicação em andamento'));
      if (tentativa === 1) anotar(t, 'A publicação automática está rodando agora; espero ela terminar e publico em seguida...');
      setTimeout(() => publicar(codigo, tentativa + 1, t), 20000);
      return;
    }
    t.fim = new Date().toISOString();
    t.ok = cod === 0;
  });
  return t;
}

// Pedido que entrou na fila da rodada automática: termina quando o estado.json registra o código de novo.
function conferirFila(codigo, t, estado) {
  if (!t || !t.naFila || t.fim) return;
  const e = estado[codigo];
  if (e && e.data > t.inicio) {
    t.fim = e.data;
    t.ok = e.status === 'ok';
    anotar(t, t.ok ? 'Foto gerada pela rodada automática.' : `Erro na geração: ${e.erro || 'sem detalhe'}`);
  } else if (!travaViva(path.join(SAIDA, '.rodando'))) {
    // a rodada fechou antes de pegar o pedido: roda direto
    const pendentes = lerLista(ARQ_URGENTE);
    if (pendentes.some(u => u.includes(`/imovel/${codigo}/`))) {
      fs.writeFileSync(ARQ_URGENTE, pendentes.filter(u => !u.includes(`/imovel/${codigo}/`)).map(u => u + '\n').join(''));
      t.naFila = false;
      anotar(t, 'A rodada automática terminou; gerando direto agora...');
      rodarScript(t, 'melhorar.js', [pendentes.find(u => u.includes(`/imovel/${codigo}/`)), '--forcar'], (cod) => {
        t.fim = new Date().toISOString();
        t.ok = cod === 0;
      });
    }
  }
}

// ---------- status de um imóvel ----------
const versao = (arq) => { try { return Math.round(fs.statSync(arq).mtimeMs); } catch { return null; } };

async function status(codigo) {
  const estado = lerJson(ARQ_ESTADO, {});
  const publicados = lerJson(ARQ_PUBLICADOS, {});
  const site = await dadosDoSite(codigo);
  const tarefa = tarefas.get(codigo);
  conferirFila(codigo, tarefa, estado);

  const e = estado[codigo] || null;
  const p = publicados[codigo] || null;
  const vCard = versao(path.join(SAIDA, `${codigo}_card-ia.jpg`));
  const vAntes = versao(path.join(PASTA_ORIG, `${codigo}_antes.png`));
  return {
    codigo,
    noSite: !!site.url,
    urlSite: site.url,
    // sem original guardada, mostra a capa atual do site (que ainda é a original enquanto não publicar)
    original: vAntes ? `/img/antes/${codigo}?v=${vAntes}` : (!p ? site.capa : null),
    card: vCard ? `/img/card/${codigo}?v=${vCard}` : null,
    ia: e ? { status: e.status, data: e.data, erro: e.erro || null, tentativas: e.tentativas || 0 } : null,
    publicado: p ? { data: p.data, site: p.site || null } : null,
    // gerou de novo depois de publicar: a do site é a antiga
    novaNaoPublicada: !!(e && e.status === 'ok' && p && e.data > p.data),
    rejeitado: lerLista(ARQ_REJEITADOS).includes(codigo),
    rodadaIA: travaViva(path.join(SAIDA, '.rodando')),
    tarefa: tarefa ? { tipo: tarefa.tipo, inicio: tarefa.inicio, fim: tarefa.fim, ok: tarefa.ok, naFila: !!tarefa.naFila, log: tarefa.log.slice(-60) } : null,
  };
}

function recentes() {
  const estado = lerJson(ARQ_ESTADO, {});
  const publicados = lerJson(ARQ_PUBLICADOS, {});
  return Object.entries(estado)
    .filter(([c, e]) => /^\d+$/.test(c) && e.status === 'ok')
    .sort((a, b) => (b[1].data > a[1].data ? 1 : -1))
    .slice(0, 24)
    .map(([c, e]) => ({ codigo: c, data: e.data, publicado: !!publicados[c], card: `/img/card/${c}?v=${versao(path.join(SAIDA, `${c}_card-ia.jpg`))}` }));
}

function alternarRejeitado(codigo) {
  const linhas = fs.existsSync(ARQ_REJEITADOS) ? fs.readFileSync(ARQ_REJEITADOS, 'utf8').replace(/\s+$/, '').split(/\r?\n/) : [];
  const tem = linhas.some(l => l.trim() === codigo);
  const novas = tem ? linhas.filter(l => l.trim() !== codigo) : [...linhas, codigo];
  fs.writeFileSync(ARQ_REJEITADOS, novas.join('\n') + '\n');
  return !tem;
}

// ---------- HTTP ----------
function responder(res, cod, corpo, tipo = 'application/json; charset=utf-8') {
  res.writeHead(cod, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  res.end(typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
}

function autorizado(req) {
  if (!SENHA) return true;
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !valor) return false;
  return Buffer.from(valor, 'base64').toString().split(':').slice(1).join(':') === SENHA;
}

const servidor = http.createServer(async (req, res) => {
  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fotos Casa Mar"' });
    return res.end('Senha necessária');
  }
  const url = new URL(req.url, 'http://x');
  const partes = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return responder(res, 200, fs.readFileSync(path.join(__dirname, 'painel.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && partes[0] === 'img' && /^\d{1,9}$/.test(partes[2] || '')) {
      const arq = partes[1] === 'card' ? path.join(SAIDA, `${partes[2]}_card-ia.jpg`)
        : partes[1] === 'antes' ? path.join(PASTA_ORIG, `${partes[2]}_antes.png`) : null;
      if (!arq || !fs.existsSync(arq)) return responder(res, 404, { erro: 'sem imagem' });
      res.writeHead(200, { 'Content-Type': arq.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=31536000' });
      return fs.createReadStream(arq).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/recentes') return responder(res, 200, recentes());

    // Sessão do ChatGPT: GET = situação; POST = arquivo sessao-chatgpt.json exportado no Windows
    if (url.pathname === '/api/sessao') {
      if (req.method === 'GET') return responder(res, 200, { ...sessao.datas(), pendente: sessao.pendente(), rodadaIA: travaViva(path.join(SAIDA, '.rodando')) });
      if (req.method === 'POST') {
        const corpo = await lerCorpo(req, 10 * 1024 * 1024);
        let json;
        try { json = JSON.parse(corpo); } catch { return responder(res, 400, { erro: 'O arquivo não é um JSON válido.' }); }
        if (!Array.isArray(json.cookies) || !json.cookies.some(c => /chatgpt\.com|openai\.com/.test(c.domain || ''))) {
          return responder(res, 400, { erro: 'Esse não parece o sessao-chatgpt.json (gere no Windows com: node melhorar.js --exportar-sessao).' });
        }
        fs.writeFileSync(sessao.arquivo, JSON.stringify(json));
        return responder(res, 200, { ok: true, mensagem: 'Sessão recebida. Ela é importada antes da próxima rodada da IA.' });
      }
    }

    if (partes[0] === 'api' && partes[1] === 'imovel') {
      const codigo = partes[2] || '';
      if (!/^\d{1,9}$/.test(codigo)) return responder(res, 400, { erro: 'Código inválido: use só números.' });
      const acao = partes[3];
      if (req.method === 'GET' && !acao) return responder(res, 200, await status(codigo));
      if (req.method === 'POST') {
        const atual = tarefas.get(codigo);
        if (atual && !atual.fim && (acao === 'gerar' || acao === 'publicar')) {
          return responder(res, 409, { erro: `Já tem uma tarefa de ${atual.tipo} rodando para este imóvel.` });
        }
        if (acao === 'gerar') {
          const site = await dadosDoSite(codigo);
          if (!site.url) return responder(res, 404, { erro: `Não achei o imóvel ${codigo} no site.` });
          gerar(codigo, site.url);
          return responder(res, 200, await status(codigo));
        }
        if (acao === 'publicar') {
          if (!fs.existsSync(path.join(SAIDA, `${codigo}_card-ia.jpg`))) return responder(res, 400, { erro: 'Ainda não tem foto gerada para publicar.' });
          publicar(codigo);
          cacheSite.delete(codigo);
          return responder(res, 200, await status(codigo));
        }
        if (acao === 'rejeitar') {
          alternarRejeitado(codigo);
          return responder(res, 200, await status(codigo));
        }
      }
    }
    responder(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    responder(res, 500, { erro: e.message });
  }
});

function lerCorpo(req, limite) {
  return new Promise((ok, falha) => {
    let total = 0;
    const partes = [];
    req.on('data', (d) => {
      total += d.length;
      if (total > limite) { falha(new Error('arquivo grande demais')); req.destroy(); return; }
      partes.push(d);
    });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

// Aberto para a rede (Easypanel) sem senha, qualquer um geraria e publicaria fotos: não sobe.
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !SENHA) {
  console.error('PAINEL_SENHA é obrigatória quando PAINEL_HOST não é 127.0.0.1. Painel não iniciado.');
  process.exitCode = 1;
} else servidor.listen(PORTA, HOST, () => {
  console.log(`Painel em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}${SENHA ? ' (com senha)' : ''}`);
});
