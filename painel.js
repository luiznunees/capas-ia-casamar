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
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DADOS, SAIDA, PASTA_DEBUG, sessao, lerConfig, salvarConfig, condominiosDoSite, resolver, urlDoImovel } = require('./fotos');
const { resumo } = require('./resumo');
const { enviarTexto, configurado } = require('./alertas');

// ---------- configuração (aba Controles / Alertas) ----------
const MASCARA = '••••••••';
let cacheCondominios = null;
function configPublica() {
  const { leitores, ...c } = lerConfig();   // acessos têm rota própria (/api/acessos); hash nunca sai daqui
  return { ...c, alertas: { ...c.alertas, apikey: c.alertas.apikey ? MASCARA : '' } };
}
function validarConfig(c) {
  if ('leitores' in c) return 'Acessos se gerenciam em /api/acessos.';
  const hora = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
  if ('janelaInicio' in c && !hora(c.janelaInicio)) return 'Hora de início inválida (0 a 23).';
  if ('janelaFim' in c && !hora(c.janelaFim)) return 'Hora de fim inválida (0 a 23).';
  if ('paralelo' in c && !(Number.isInteger(c.paralelo) && c.paralelo >= 1 && c.paralelo <= 5)) return 'Abas: de 1 a 5.';
  if ('prioridades' in c && !(Array.isArray(c.prioridades) && c.prioridades.every(s => /^[a-z0-9-]+$/.test(s)))) return 'Lista de prioridades inválida.';
  for (const k of ['iaAutomatica', 'publicarAutomatico']) if (k in c && typeof c[k] !== 'boolean') return `${k} inválido.`;
  if (c.alertas) {
    const a = c.alertas;
    if (a.url && !/^https?:\/\//.test(a.url)) return 'URL da Evolution deve começar com http:// ou https://';
    const grupo = /^\d+(-\d+)?@g\.us$/.test(String(a.numero || '').trim());
    if (a.numero && !grupo && String(a.numero).replace(/\D/g, '').length < 10) return 'Número do WhatsApp com DDI e DDD (ex.: 5551999999999) ou um grupo (…@g.us)';
  }
  return null;
}

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
    // gerou: publica em seguida, se a publicação automática estiver ligada e o imóvel não estiver bloqueado
    if (cod === 0 && lerConfig().publicarAutomatico && !lerLista(ARQ_REJEITADOS).includes(codigo)) {
      anotar(t, '');
      anotar(t, 'Foto gerada. Publicando automaticamente no Jetimob e no site...');
      t.tipo = 'publicar';
      publicar(codigo, 1, t);
      return;
    }
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

function printsDeErro() {
  const lista = [];
  const juntar = (pasta, filtro) => {
    if (!fs.existsSync(pasta)) return;
    for (const f of fs.readdirSync(pasta)) {
      if (!filtro.test(f)) continue;
      const caminho = path.join(pasta, f);
      lista.push({ arquivo: f, caminho, data: new Date(fs.statSync(caminho).mtimeMs).toISOString() });
    }
  };
  juntar(PASTA_DEBUG, /\.png$/);
  juntar(SAIDA, /(_erro-jetimob|^debug-ultimo-erro)\.png$/);
  return lista.sort((a, b) => (b.data > a.data ? 1 : -1)).slice(0, 80);
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

// ---------- login ----------
// Dois papéis: "admin" (PAINEL_USUARIO/PAINEL_SENHA do Easypanel) e "leitura" (acessos criados no
// painel, aba Controles, guardados com hash scrypt em config.json). Cookie assinado com HMAC:
// sobrevive a reinícios e deploys, e cai sozinho se a senha mudar ou o acesso for removido.
// Basic auth continua valendo só para o admin (chamadas de API, scripts, curl).
const USUARIO = process.env.PAINEL_USUARIO || 'admin';
const DIAS_LOGADO = 30;
const COOKIE = 'capas_sessao';
const assinar = (texto) => crypto.createHmac('sha256', `capas-ia:${SENHA}`).update(texto).digest('base64url');
const iguais = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const normalizar = (u) => String(u || '').trim().toLowerCase();

// ---------- acessos de leitura ----------
const hashSenha = (senha, sal) => crypto.scryptSync(String(senha), sal, 32).toString('base64url');
const leitores = () => lerConfig().leitores || [];
function conferirLeitor(usuario, senha) {
  const l = leitores().find(x => x.usuario === normalizar(usuario));
  return l && iguais(hashSenha(senha, l.sal), l.hash) ? l : null;
}

// O que entra na assinatura: trocar a senha (hash) ou remover o acesso invalida o cookie.
function segredoDe(usuario, papel) {
  if (papel === 'admin') return normalizar(usuario) === normalizar(USUARIO) ? 'admin' : null;
  return leitores().find(x => x.usuario === usuario)?.hash || null;
}
function tokenDe(usuario, papel, validade) {
  return `${validade}.${encodeURIComponent(usuario)}.${papel}.${assinar(`${usuario}|${papel}|${validade}|${segredoDe(usuario, papel)}`)}`;
}

// { usuario, papel } da sessão, ou null
function sessaoDe(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [validade, usuarioCod, papel, assinatura] = decodeURIComponent(m[1]).split('.');
  const usuario = decodeURIComponent(usuarioCod || '');
  if (!(+validade > Date.now()) || !['admin', 'leitura'].includes(papel) || !segredoDe(usuario, papel)) return null;
  return iguais(assinatura || '', assinar(`${usuario}|${papel}|${validade}|${segredoDe(usuario, papel)}`)) ? { usuario, papel } : null;
}

function quemE(req) {
  if (!SENHA) return { usuario: 'local', papel: 'admin' };
  const s = sessaoDe(req);
  if (s) return s;
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Basic' && valor && iguais(Buffer.from(valor, 'base64').toString().split(':').slice(1).join(':'), SENHA)) {
    return { usuario: USUARIO, papel: 'admin' };
  }
  return null;
}

// Leitura: só GET e só o que é para ver. Config, sessão do ChatGPT, fila, acessos e alertas ficam de fora.
const SO_ADMIN = ['/api/config', '/api/sessao', '/api/fila', '/api/acessos', '/api/alertas', '/api/sincronizar', '/api/debug', '/img/debug'];
function permitido(quem, req, url) {
  if (quem.papel === 'admin') return true;
  if (req.method !== 'GET') return false;
  return !SO_ADMIN.some(p => url.pathname === p || url.pathname.startsWith(p + '/'));
}

function cookieSessao(req, valor, maxAge) {
  const https = (req.headers['x-forwarded-proto'] || '').includes('https');
  return `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}

// Senha errada demais: 8 tentativas por IP a cada 15 min.
const tentativas = new Map();   // ip -> { n, desde }
const ipDe = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() - t.desde > 15 * 60 * 1000) { tentativas.delete(ip); return false; }
  return t.n >= 8;
}
function errou(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() - t.desde > 15 * 60 * 1000) tentativas.set(ip, { n: 1, desde: Date.now() });
  else t.n++;
}

async function rotasDeLogin(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/login') {
    if (!SENHA || sessaoDe(req)) { res.writeHead(302, { Location: '/' }); res.end(); return true; }
    responder(res, 200, fs.readFileSync(path.join(__dirname, 'login.html')), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const ip = ipDe(req);
    if (bloqueado(ip)) { responder(res, 429, { erro: 'Muitas tentativas. Espere 15 minutos e tente de novo.' }); return true; }
    let corpo = {};
    try { corpo = JSON.parse(await lerCorpo(req, 10 * 1024)); } catch {}
    const usuario = normalizar(corpo.usuario);
    let papel = null;
    if (SENHA && iguais(usuario, normalizar(USUARIO)) && iguais(corpo.senha || '', SENHA)) papel = 'admin';
    else if (SENHA && conferirLeitor(usuario, corpo.senha || '')) papel = 'leitura';
    if (!papel) {
      errou(ip);
      await new Promise(r => setTimeout(r, 600));   // atrasa quem tenta adivinhar
      responder(res, 401, { erro: 'Usuário ou senha incorretos.' });
      return true;
    }
    tentativas.delete(ip);
    const nome = papel === 'admin' ? USUARIO : usuario;
    const validade = Date.now() + DIAS_LOGADO * 24 * 3600 * 1000;
    res.setHeader('Set-Cookie', cookieSessao(req, tokenDe(nome, papel, validade), DIAS_LOGADO * 24 * 3600));
    responder(res, 200, { ok: true, papel });
    return true;
  }
  if (url.pathname === '/api/logout') {
    res.setHeader('Set-Cookie', cookieSessao(req, '', 0));
    if (req.method === 'GET') { res.writeHead(302, { Location: '/login' }); res.end(); }
    else responder(res, 200, { ok: true });
    return true;
  }
  return false;
}

// Acessos de leitura (só admin): listar, criar/trocar senha, remover.
async function rotasDeAcessos(req, res, url, partes) {
  if (partes[0] !== 'api' || partes[1] !== 'acessos') return false;
  const lista = () => leitores().map(l => ({ usuario: l.usuario, criado: l.criado }));
  if (req.method === 'GET' && !partes[2]) { responder(res, 200, lista()); return true; }
  if (req.method === 'POST' && !partes[2]) {
    const { usuario, senha } = JSON.parse(await lerCorpo(req, 10 * 1024));
    const u = normalizar(usuario);
    if (!/^[a-z0-9._-]{3,30}$/.test(u)) { responder(res, 400, { erro: 'Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _.' }); return true; }
    if (u === normalizar(USUARIO)) { responder(res, 400, { erro: 'Esse é o usuário do administrador.' }); return true; }
    if (String(senha || '').length < 8) { responder(res, 400, { erro: 'A senha precisa de pelo menos 8 caracteres.' }); return true; }
    const sal = crypto.randomBytes(16).toString('base64url');
    const outros = leitores().filter(l => l.usuario !== u);
    salvarConfig({ leitores: [...outros, { usuario: u, sal, hash: hashSenha(senha, sal), criado: new Date().toISOString() }] });
    responder(res, 200, lista());
    return true;
  }
  if (req.method === 'DELETE' && partes[2]) {
    const u = normalizar(decodeURIComponent(partes[2]));
    salvarConfig({ leitores: leitores().filter(l => l.usuario !== u) });
    responder(res, 200, lista());
    return true;
  }
  return false;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await rotasDeLogin(req, res, url)) return;
  const quem = quemE(req);
  if (!quem) {
    // página: vai para a tela de login; API e imagens: 401
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return responder(res, 401, { erro: 'Faça login de novo.', login: true });
  }
  if (!permitido(quem, req, url)) return responder(res, 403, { erro: 'Seu acesso é só para visualizar.' });
  const partes = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/api/eu') return responder(res, 200, quem);
    if (await rotasDeAcessos(req, res, url, partes)) return;
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

    // Prints de tela salvos quando algo falha (só admin): saida/debug/ e os antigos *_erro-jetimob.png
    if (req.method === 'GET' && url.pathname === '/api/debug') return responder(res, 200, printsDeErro().map(({ arquivo, data }) => ({ arquivo, data })));
    if (req.method === 'GET' && partes[0] === 'img' && partes[1] === 'debug' && /^[\w.-]+\.png$/.test(partes[2] || '')) {
      const arq = printsDeErro().find(p => p.arquivo === partes[2]);
      if (!arq) return responder(res, 404, { erro: 'sem imagem' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return fs.createReadStream(arq.caminho).pipe(res);
    }

    // ---------- admin: visão geral, controles, alertas ----------
    if (req.method === 'GET' && url.pathname === '/api/resumo') {
      return responder(res, 200, {
        ...resumo(),
        rodada: global.agendador ? global.agendador.situacao() : null,
        sessao: { ...sessao.datas(), pendente: sessao.pendente() },
        alertasConfigurados: configurado(),
      });
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'GET') return responder(res, 200, configPublica());
      if (req.method === 'POST') {
        const novo = JSON.parse(await lerCorpo(req, 100 * 1024));
        const erro = validarConfig(novo);
        if (erro) return responder(res, 400, { erro });
        // chave mascarada (ou qualquer coisa que não seja texto simples) = não mexeu na chave
        if (novo.alertas && 'apikey' in novo.alertas && !/^[\x21-\x7e]*$/.test(novo.alertas.apikey)) delete novo.alertas.apikey;
        salvarConfig(novo);
        return responder(res, 200, configPublica());
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/condominios') {
      if (!cacheCondominios || Date.now() - cacheCondominios.em > 24 * 3600 * 1000) {
        cacheCondominios = { em: Date.now(), lista: await condominiosDoSite() };
      }
      return responder(res, 200, cacheCondominios.lista);
    }
    if (url.pathname === '/api/fila/urgente') {
      if (req.method === 'GET') return responder(res, 200, lerLista(ARQ_URGENTE));
      if (req.method === 'POST') {
        const { codigos = [] } = JSON.parse(await lerCorpo(req, 100 * 1024));
        const validos = [...new Set(codigos.map(String).map(c => c.trim()).filter(c => /^\d{1,9}$/.test(c)))].slice(0, 200);
        const achados = [], naoAchados = [];
        for (const c of validos) {
          const site = await dadosDoSite(c).catch(() => ({}));
          (site.url ? achados : naoAchados).push(site.url ? site.url : c);
        }
        if (achados.length) fs.appendFileSync(ARQ_URGENTE, achados.map(u => u + '\n').join(''));
        return responder(res, 200, { adicionados: achados.length, naoAchados, fila: lerLista(ARQ_URGENTE) });
      }
      if (req.method === 'DELETE') { fs.writeFileSync(ARQ_URGENTE, ''); return responder(res, 200, []); }
    }
    if (req.method === 'POST' && url.pathname === '/api/alertas/teste') {
      try {
        await enviarTexto('🏠 *Capas IA* · _Casa Mar_\n\n✅ *Teste de alerta*\n_Se você recebeu isto, os avisos do painel estão funcionando._');
        return responder(res, 200, { ok: true, mensagem: 'Mensagem de teste enviada.' });
      } catch (e) { return responder(res, 400, { erro: e.message }); }
    }

    // Rodadas automáticas (só quando o painel roda dentro do agendador.js)
    if (partes[0] === 'api' && partes[1] === 'rodada') {
      const ag = global.agendador;
      if (!ag) return responder(res, 400, { erro: 'O painel não está rodando junto com o agendador (agendador.js).' });
      if (req.method === 'GET') return responder(res, 200, ag.situacao());
      if (req.method === 'POST' && (partes[2] === 'ia' || partes[2] === 'publicar')) {
        const aberta = partes[2] === 'ia' ? ag.situacao().iaAberta : ag.situacao().pubAberta;
        if (aberta) return responder(res, 409, { erro: `A rodada de ${partes[2]} já está em andamento.` });
        ag[partes[2]]();   // não espera: a rodada pode levar horas
        return responder(res, 200, { ok: true, mensagem: `Rodada de ${partes[2]} iniciada.` });
      }
    }

    // Sincroniza um imóvel trabalhado em outra máquina: registro de publicação, estado e fotos (base64).
    // Corpo: { estado?, publicado?, antes?, card? }
    if (req.method === 'POST' && partes[0] === 'api' && partes[1] === 'sincronizar' && /^\d{1,9}$/.test(partes[2] || '')) {
      const codigo = partes[2];
      const corpo = JSON.parse(await lerCorpo(req, 30 * 1024 * 1024));
      fs.mkdirSync(PASTA_ORIG, { recursive: true });
      if (corpo.antes) fs.writeFileSync(path.join(PASTA_ORIG, `${codigo}_antes.png`), Buffer.from(corpo.antes, 'base64'));
      if (corpo.card) fs.writeFileSync(path.join(SAIDA, `${codigo}_card-ia.jpg`), Buffer.from(corpo.card, 'base64'));
      const gravarJson = (arq, valor) => {
        if (!valor) return;
        const todos = lerJson(arq, {});
        todos[codigo] = valor;
        fs.writeFileSync(arq + '.tmp', JSON.stringify(todos, null, 1));
        fs.renameSync(arq + '.tmp', arq);
      };
      gravarJson(ARQ_ESTADO, corpo.estado);
      gravarJson(ARQ_PUBLICADOS, corpo.publicado);
      return responder(res, 200, await status(codigo));
    }

    // Últimas linhas do log de hoje das rodadas automáticas (agendador.js): /api/logs/ia ou /api/logs/publicar
    if (req.method === 'GET' && partes[0] === 'api' && partes[1] === 'logs' && ['ia', 'publicar'].includes(partes[2])) {
      const arq = path.join(DADOS, 'logs', `${partes[2]}-${new Date().toLocaleDateString('sv-SE')}.log`);
      const linhas = fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split(/\r?\n/).slice(-200) : [];
      return responder(res, 200, { arquivo: path.basename(arq), linhas });
    }

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
